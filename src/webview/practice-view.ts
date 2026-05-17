import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  config,
  errorMessage,
  isAudioUnderstandingProvider,
  isCoachProvider,
  isProviderName,
  isTtsProvider,
  stringValue,
} from "../core.js";
import type {
  CoachPriorTurn,
  JsonObject,
  PracticeResult,
  PracticeTarget,
  StageReporter,
  WebviewAudioMessage,
} from "../types.js";
import { extensionFromMime } from "../practice/transcribe.js";
import { createSessionDir, processPracticeFile } from "../practice/pipeline.js";
import { generateDrillLines as coachGenerateDrillLines } from "../practice/coach.js";
import { buildPracticeHtml } from "./html.js";
import { openMaterialsGuide } from "../materials-guide.js";
import { refreshAll, runConfigureSetting } from "../runtime/host.js";
import { isConfigSettingName } from "../runtime/settings.js";
import {
  configureApiKey,
  configureCoreRouteKeys,
  configureLocalMaterialsRoot,
  setGeminiOnlyProviders,
  setMinimaxVoiceId,
  setProviderSetting,
  setRecommendedHybridProviders,
  setTtsSpeedConfig,
} from "../commands/provider-routes.js";
import {
  completeLocalPackage,
  openCurrentTaskCard,
  openSessionFolder,
} from "../commands/local-actions.js";
import { createSamplePackage, generateNextPackage } from "../materials/scaffold.js";
import { composeMaterialPrompt } from "../materials/prompt-composer.js";
import { expandHome } from "../runtime/training-root.js";
import { invalidateNextPackageCache, loadState, toWebviewState } from "../runtime/state.js";
import {
  killActiveNativeRecording,
  startNativeFfmpegRecording,
  stopNativeFfmpegRecording,
} from "../audio/native-recording.js";
import { synthesizeOnDemandText, synthesizeTodayAudio } from "../audio/synthesis.js";

export class PracticeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingPriorTurn?: CoachPriorTurn;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.applyResourceRoots();
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    // If the practice view is torn down (panel closed/moved) while a native
    // ffmpeg recorder is running, deactivate() never fires, so the recorder
    // would keep holding the microphone and a re-resolved view could never
    // start a new recording ("already running"). Stop it on disposal.
    view.onDidDispose(() => {
      killActiveNativeRecording();
      this.view = undefined;
    });
    void this.postState();
  }

  async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    try {
      const state = await loadState(this.context);
      this.applyResourceRoots(state.root);
      this.view.webview.postMessage({ type: "state", state: toWebviewState(this.view.webview, state) });
    } catch (error) {
      this.view.webview.postMessage({ type: "error", message: errorMessage(error) });
    }
  }

  private applyResourceRoots(materialsRoot?: string): void {
    if (!this.view) {
      return;
    }
    const configuredRoot = expandHome(config<string>("localMaterialsRoot") || "").trim();
    const roots = [
      vscode.Uri.file(this.context.extensionPath),
      this.context.globalStorageUri,
      ...((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)),
      ...(configuredRoot ? [vscode.Uri.file(configuredRoot)] : []),
      ...(materialsRoot ? [vscode.Uri.file(materialsRoot)] : []),
    ];
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: dedupeUris(roots),
    };
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.view || typeof message !== "object" || !message) {
      return;
    }
    const payload = message as JsonObject;
    try {
      if (payload.type === "ready" || payload.type === "refresh") {
        // An explicit user refresh must re-detect externally-changed
        // packages/completion; "ready" is the initial load (a cache miss
        // anyway), so only the explicit refresh drops the cache.
        if (payload.type === "refresh") {
          invalidateNextPackageCache();
        }
        await this.postState();
        return;
      }
      if (payload.type === "configureKey") {
        const provider = payload.provider;
        if (isProviderName(provider)) {
          await configureApiKey(this.context, provider);
        }
        return;
      }
      if (payload.type === "setProvider") {
        if (payload.setting === "coachProvider" && isCoachProvider(payload.value)) {
          await setProviderSetting("coachProvider", payload.value);
        } else if (payload.setting === "audioUnderstandingProvider" && isAudioUnderstandingProvider(payload.value)) {
          await setProviderSetting("audioUnderstandingProvider", payload.value);
        } else if (payload.setting === "ttsProvider" && isTtsProvider(payload.value)) {
          await setProviderSetting("ttsProvider", payload.value);
        } else {
          // Never let a provider "Use" click silently no-op: the card would
          // look clickable but dead. Tell the user why it was rejected.
          this.view.webview.postMessage({
            type: "error",
            message: `Cannot use "${stringValue(payload.value)}" for ${stringValue(payload.setting)}.`,
          });
        }
        return;
      }
      if (payload.type === "configureSetting" && isConfigSettingName(payload.setting)) {
        await runConfigureSetting(payload.setting);
        return;
      }
      if (payload.type === "setMinimaxVoice") {
        const voiceId = stringValue(payload.voiceId);
        if (voiceId) {
          await setMinimaxVoiceId(voiceId, Boolean(payload.pinTurbo));
        }
        return;
      }
      if (payload.type === "setTtsSpeed") {
        const value = Number(payload.value);
        if (Number.isFinite(value) && value > 0) {
          await setTtsSpeedConfig(value);
        }
        return;
      }
      if (payload.type === "useGeminiOnly") {
        await setGeminiOnlyProviders();
        return;
      }
      if (payload.type === "useRecommendedHybrid") {
        await setRecommendedHybridProviders();
        return;
      }
      if (payload.type === "slowRead") {
        const text = stringValue(payload.text);
        const target = stringValue(payload.target) || "native";
        const speed = Number(payload.speed);
        await this.slowReadText(text, target, Number.isFinite(speed) && speed > 0 ? speed : 0.7);
        return;
      }
      if (payload.type === "setReplyContext") {
        const priorTurn = payload.priorTurn as CoachPriorTurn | undefined;
        this.pendingPriorTurn = priorTurn && priorTurn.nativeVersion ? priorTurn : undefined;
        return;
      }
      if (payload.type === "clearReplyContext") {
        this.pendingPriorTurn = undefined;
        return;
      }
      if (payload.type === "completeLocal") {
        await completeLocalPackage(this.context);
        return;
      }
      if (payload.type === "command") {
        if (payload.command === "configureMaterials") {
          await configureLocalMaterialsRoot();
        }
        if (payload.command === "openTask") {
          await openCurrentTaskCard(this.context);
        }
        if (payload.command === "openSessionFolder") {
          await openSessionFolder(this.context);
        }
        if (payload.command === "setupProviderKey") {
          await configureCoreRouteKeys(this.context);
        }
        if (payload.command === "createSamplePackage") {
          await createSamplePackage(this.context);
        }
        if (payload.command === "generateNextPackage") {
          await generateNextPackage(this.context);
        }
        if (payload.command === "composeMaterialPrompt") {
          await composeMaterialPrompt(this.context);
        }
        if (payload.command === "openMaterialsGuide") {
          await openMaterialsGuide();
        }
        return;
      }
      if (payload.type === "startNativeRecording") {
        await this.startNativeRecording(normalizePracticeTargetPayload(payload.practiceTarget));
        return;
      }
      if (payload.type === "stopNativeRecording") {
        await this.stopNativeRecording();
        return;
      }
      if (payload.type === "practiceAudio") {
        await this.runPractice(payload as unknown as WebviewAudioMessage);
        return;
      }
      if (payload.type === "todayTts") {
        await this.generateTodayTts();
        return;
      }
      if (payload.type === "generateDrillLines") {
        const count = Number(payload.count);
        const existing = Array.isArray(payload.existing)
          ? payload.existing.map((item) => stringValue(item)).filter(Boolean)
          : [];
        await this.generateDrillLines(Number.isFinite(count) && count > 0 ? count : 5, existing);
        return;
      }
    } catch (error) {
      this.view.webview.postMessage({ type: "error", message: errorMessage(error) });
    }
  }

  private async generateTodayTts(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "todayTtsStatus", message: "Generating example audio…" });
    const result = await synthesizeTodayAudio(this.context);
    this.view.webview.postMessage({ type: "todayTtsResult", result });
  }

  private async generateDrillLines(count: number, existing: string[]): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "drillLinesStatus", message: "Generating new lines…" });
    try {
      const state = await loadState(this.context);
      const lines = await coachGenerateDrillLines(this.context, state, count, existing);
      this.view.webview.postMessage({ type: "drillLinesResult", lines });
    } catch (error) {
      this.view.webview.postMessage({ type: "drillLinesResult", error: errorMessage(error) });
    }
  }

  private async slowReadText(text: string, target: string, speed: number): Promise<void> {
    if (!this.view) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const slowSpeed = Number.isFinite(speed) && speed > 0 ? Math.max(0.5, Math.min(1.5, speed)) : 0.7;
    this.view.webview.postMessage({ type: "slowReadStatus", target, message: "Re-reading…" });
    try {
      const result = await synthesizeOnDemandText(this.context, trimmed, slowSpeed);
      this.view.webview.postMessage({ type: "slowReadResult", target, result });
    } catch (error) {
      this.view.webview.postMessage({
        type: "slowReadResult",
        target,
        error: errorMessage(error),
      });
    }
  }

  private stageReporter(): StageReporter {
    return (stage, status) => {
      this.view?.webview.postMessage({ type: "stage", stage, status, show: true });
    };
  }

  private async runPractice(message: WebviewAudioMessage): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "stage", stage: "transcribe", status: "active", show: true });
    const priorTurn = message.priorTurn ?? this.pendingPriorTurn;
    const practiceTarget = normalizePracticeTargetPayload(message.practiceTarget);
    const result = await processPracticeAudio(this.context, message, this.stageReporter(), priorTurn, practiceTarget);
    this.pendingPriorTurn = undefined;
    const audioUri = result.audioFile ? this.view.webview.asWebviewUri(vscode.Uri.file(result.audioFile)).toString() : "";
    const followUpAudioUri = result.followUpAudioFile
      ? this.view.webview.asWebviewUri(vscode.Uri.file(result.followUpAudioFile)).toString()
      : "";
    this.view.webview.postMessage({
      type: "practiceResult",
      result: {
        ...result,
        audioUri,
        followUpAudioUri,
        priorTurn: priorTurn ?? null,
        practiceTarget: practiceTarget ?? null,
      },
    });
    await refreshAll();
  }

  private async startNativeRecording(practiceTarget?: PracticeTarget): Promise<void> {
    if (!this.view) {
      return;
    }
    const view = this.view;
    // Stream the prep phases so "press record → can speak" is a visible,
    // moving progression instead of one frozen line. Now that device
    // enumeration is async (no spawnSync host freeze), these flush live.
    const session = await startNativeFfmpegRecording(this.context, practiceTarget, (phase) => {
      view.webview.postMessage({ type: "nativeRecordingPreparing", phase });
    });
    view.webview.postMessage({
      type: "nativeRecordingStarted",
      sessionDir: session.sessionDir,
    });
  }

  private async stopNativeRecording(): Promise<void> {
    if (!this.view) {
      return;
    }
    // Do NOT light the "transcribe" stage here: stopNativeFfmpegRecording()
    // is a 0.15–5s ffmpeg drain (q → SIGINT → SIGTERM → settle), and showing
    // the strip with Transcribe blinking during that window mislabels a
    // multi-second wait exactly the way record-start used to. The webview
    // already shows an honest "Stopping native recorder…" status on the stop
    // press; the strip should appear only when transcription truly starts,
    // which the pipeline's own progress("transcribe","active") reports.
    const session = await stopNativeFfmpegRecording();
    const state = await loadState(this.context);
    const priorTurn = this.pendingPriorTurn;
    const practiceTarget = session.practiceTarget;
    const result = await processPracticeFile(
      this.context,
      state,
      session.filePath,
      "audio/wav",
      session.sessionDir,
      session.packageDate,
      this.stageReporter(),
      priorTurn,
      practiceTarget,
    );
    this.pendingPriorTurn = undefined;
    const audioUri = result.audioFile ? this.view.webview.asWebviewUri(vscode.Uri.file(result.audioFile)).toString() : "";
    const followUpAudioUri = result.followUpAudioFile
      ? this.view.webview.asWebviewUri(vscode.Uri.file(result.followUpAudioFile)).toString()
      : "";
    this.view.webview.postMessage({
      type: "practiceResult",
      result: {
        ...result,
        audioUri,
        followUpAudioUri,
        localAudioUri: this.view.webview.asWebviewUri(vscode.Uri.file(session.filePath)).toString(),
        priorTurn: priorTurn ?? null,
        practiceTarget: practiceTarget ?? null,
      },
    });
    await refreshAll();
  }

  private html(webview: vscode.Webview): string {
    return buildPracticeHtml(webview, this.context.extensionUri);
  }
}

export async function processPracticeAudio(
  context: vscode.ExtensionContext,
  message: WebviewAudioMessage,
  progress?: StageReporter,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
): Promise<PracticeResult> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const inputExt = extensionFromMime(message.mimeType);
  const inputPath = path.join(sessionDir, `input.${inputExt}`);
  const audioBuffer = Buffer.from(message.base64, "base64");
  if (audioBuffer.length < 1000) {
    throw new Error("Recorded audio is empty or too short to process.");
  }
  fs.writeFileSync(inputPath, audioBuffer);
  return processPracticeFile(
    context,
    state,
    inputPath,
    message.mimeType,
    sessionDir,
    packageDate,
    progress,
    priorTurn,
    practiceTarget,
  );
}

export function normalizePracticeTargetPayload(value: unknown): PracticeTarget | undefined {
  const obj = (value && typeof value === "object" ? value : undefined) as JsonObject | undefined;
  const referenceText = stringValue(obj?.referenceText).trim();
  if (!referenceText) {
    return undefined;
  }
  return {
    mode: "shadow",
    referenceText,
    referenceLabel: stringValue(obj?.referenceLabel).trim() || "Reference",
    followUpQuestion: stringValue(obj?.followUpQuestion).trim(),
  };
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];
  for (const uri of uris) {
    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(uri);
    }
  }
  return result;
}
