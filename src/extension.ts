import { Blob } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  ActiveMaterialsSource,
  AvfoundationAudioDevice,
  CoachPriorTurn,
  CommandResult,
  JsonObject,
  KeyAvailability,
  LearnerProfile,
  NativeRecordingSession,
  PracticeResult,
  PracticeStage,
  PracticeTarget,
  ProgressCell,
  ProgressSnapshot,
  ProviderName,
  SourceDiagnostics,
  StageReporter,
  StageStatus,
  TrainingState,
  WebviewAudioMessage,
} from "./types.js";
import {
  appendOutput,
  arrayOfStrings,
  config,
  errorMessage,
  isAudioUnderstandingProvider,
  isCoachProvider,
  isProviderName,
  isTtsProvider,
  MIMO_ANTHROPIC_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL,
  normalizeTtsSpeed,
  parseLooseJson,
  parseFirstJson,
  providerLabel,
  readJson,
  readJsonDiagnosed,
  resolveFfmpegPath,
  secretKeys,
  setOutputChannel,
  showOutput,
  stamp,
  stringValue,
  writeJson,
} from "./core.js";
import { extensionFromMime } from "./practice/transcribe.js";
import {
  mimeTypeForAudioPath,
  speechOutputExtension,
  synthesizeWithConfiguredTts,
} from "./practice/tts.js";
import {
  createSessionDir,
  drillExamplesFromState,
  normalizeDrillExamples,
  processPracticeFile,
  readRecentSessionLog,
  splitPracticeText,
} from "./practice/pipeline.js";
import { generateDrillLines as coachGenerateDrillLines } from "./practice/coach.js";
import { buildPracticeHtml } from "./webview/html.js";
import { openMaterialsGuide } from "./materials-guide.js";
import {
  clearRefreshHandlers,
  refreshAll,
  registerConfigureSetting,
  registerProviderSetupHint,
  registerRefreshHandler,
} from "./runtime/host.js";
import {
  type ConfigSettingName,
  type ProviderSettingName,
  isConfigSettingName,
  normalizedSpeechInputProvider,
  pythonPath,
  trainingSettings,
} from "./runtime/settings.js";
import {
  apiKeyAvailability,
  clearApiKeys,
  configureApiKey,
  configureCoreRouteKeys,
  configureLocalMaterialsRoot,
  migrateGeminiModelDefaults,
  setGeminiOnlyProviders,
  setMinimaxVoiceId,
  setProviderSetting,
  setRecommendedHybridProviders,
  setTtsSpeedConfig,
} from "./commands/provider-routes.js";
import {
  completeLocalPackage,
  openCurrentTaskCard,
  openSessionFolder,
  revealCurrentPackage,
} from "./commands/local-actions.js";
import {
  dateRangeLabel,
  execFile,
  expandHome,
  findTrainingRoot,
  isHttpUrl,
  looksLikeTrainingRoot,
  readLocalInventory,
  todayInConfiguredTimezone,
} from "./runtime/training-root.js";
import { loadLocalLearnerProfile } from "./runtime/learner-profile.js";
import {
  buildProgressSnapshot,
  invalidateNextPackageCache,
  loadState,
  packageAssets,
  todayExampleText,
  toWebviewState,
} from "./runtime/state.js";
import {
  chooseLocalAvfoundationAudioDevice,
  invalidateResolvedAudioDevice,
  killActiveNativeRecording,
  listAvfoundationAudioDevices,
  parseAvfoundationAudioDevices,
  resolveNativeFfmpegAudioDevice,
  startNativeFfmpegRecording,
  stopNativeFfmpegRecording,
} from "./audio/native-recording.js";
import { synthesizeOnDemandText, synthesizeTodayAudio } from "./audio/synthesis.js";
import { sampleFollowupDrillPackage, sampleTrainingPackage } from "./materials/sample-package.js";
import { createSamplePackage, generateNextPackage } from "./materials/scaffold.js";
import { composeMaterialPrompt } from "./materials/prompt-composer.js";
import { StatusProvider } from "./status/status-tree.js";
import { PracticeViewProvider, normalizePracticeTargetPayload } from "./webview/practice-view.js";
import {
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
  CARD_SCHEMA_VERSION,
  cardSchemaContractJson,
} from "./card-schema.js";

let statusProvider: StatusProvider;
let practiceProvider: PracticeViewProvider;

const GEMINI_TEXT_MODEL_OPTIONS = [
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
];

const GEMINI_TTS_MODEL_OPTIONS = [
  "gemini-3.1-flash-tts-preview",
];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("English Training");
  setOutputChannel(output);
  statusProvider = new StatusProvider(context);
  practiceProvider = new PracticeViewProvider(context);

  clearRefreshHandlers();
  registerRefreshHandler(() => statusProvider.refresh());
  registerRefreshHandler(() => practiceProvider.postState());
  registerConfigureSetting((s) => configureSetting(s as ConfigSettingName));
  registerProviderSetupHint((provider) => providerSetupHint(provider as ProviderName));

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("englishTraining.status", statusProvider));
  // retainContextWhenHidden: the practice cockpit holds the whole live
  // session in webview JS memory (turn history, last coaching, generated
  // drill lines, armed reply/shadow context) and persists none of it via
  // vscode.setState. Without this, collapsing the view or clicking another
  // sidebar item tears the webview down and silently wipes an in-progress
  // session; it also strands a running native ffmpeg recorder whose only
  // stop hook is onDidDispose (which does not fire on hide), bricking the
  // recorder ("already running") on return. Keeping the context costs some
  // memory while hidden — the right trade for a practice session.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("englishTraining.practice", practiceProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("englishTraining.openPractice", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.englishTraining");
    await vscode.commands.executeCommand("englishTraining.practice.focus");
  });
  register("englishTraining.refresh", async () => {
    // Explicit user refresh must re-detect externally-changed packages or
    // completion, so drop the memoized next-package before re-resolving.
    invalidateNextPackageCache();
    await refreshAll();
  });
  register("englishTraining.configureLocalMaterials", async () => {
    await configureLocalMaterialsRoot();
  });
  register("englishTraining.configureOpenAIKey", async () => {
    await configureApiKey(context, "openai");
  });
  register("englishTraining.configureGeminiKey", async () => {
    await configureApiKey(context, "gemini");
  });
  register("englishTraining.configureMiniMaxKey", async () => {
    await configureApiKey(context, "minimax");
  });
  register("englishTraining.configureMimoKey", async () => {
    await configureApiKey(context, "mimo");
  });
  register("englishTraining.clearApiKeys", async () => {
    await clearApiKeys(context);
  });
  register("englishTraining.useGeminiCoach", async () => {
    await setProviderSetting("coachProvider", "gemini");
  });
  register("englishTraining.useMimoCoach", async () => {
    await setProviderSetting("coachProvider", "mimo");
  });
  register("englishTraining.useOpenAICoach", async () => {
    await setProviderSetting("coachProvider", "openai");
  });
  register("englishTraining.useOpenAIRealtimeAudioUnderstanding", async () => {
    await setProviderSetting("audioUnderstandingProvider", "openai");
  });
  register("englishTraining.useMiniMaxTts", async () => {
    await setProviderSetting("ttsProvider", "minimax");
  });
  register("englishTraining.useOpenAITts", async () => {
    await setProviderSetting("ttsProvider", "openai");
  });
  register("englishTraining.useGeminiTts", async () => {
    await setProviderSetting("ttsProvider", "gemini");
  });
  register("englishTraining.useGeminiOnly", async () => {
    await setGeminiOnlyProviders();
  });
  register("englishTraining.useRecommendedHybrid", async () => {
    await setRecommendedHybridProviders();
  });
  register("englishTraining.completeLocal", async () => {
    await completeLocalPackage(context);
  });
  register("englishTraining.openTaskCard", async () => {
    await openCurrentTaskCard(context);
  });
  register("englishTraining.revealPackage", async () => {
    await revealCurrentPackage(context);
  });
  register("englishTraining.openSessionFolder", async () => {
    await openSessionFolder(context);
  });
  register("englishTraining.createSamplePackage", async () => {
    await createSamplePackage(context);
  });
  register("englishTraining.generateNextPackage", async () => {
    await generateNextPackage(context);
  });
  register("englishTraining.composeMaterialPrompt", async () => {
    await composeMaterialPrompt(context);
  });
  register("englishTraining.openMaterialsGuide", async () => {
    await openMaterialsGuide();
  });

  void refreshAll();
  void migrateGeminiModelDefaults();
}

export function deactivate(): void {
  killActiveNativeRecording();
}

export const __test__ = {
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
  buildProgressSnapshot,
  CARD_SCHEMA_VERSION,
  cardSchemaContractJson,
  chooseLocalAvfoundationAudioDevice,
  dateRangeLabel,
  drillExamplesFromState,
  extensionFromMime,
  invalidateResolvedAudioDevice,
  listAvfoundationAudioDevices,
  looksLikeTrainingRoot,
  mimeTypeForAudioPath,
  normalizedSpeechInputProvider,
  normalizePracticeTargetPayload,
  normalizeDrillExamples,
  normalizeTtsSpeed,
  packageAssets,
  parseAvfoundationAudioDevices,
  parseLooseJson,
  readJsonDiagnosed,
  resolveNativeFfmpegAudioDevice,
  speechOutputExtension,
  todayExampleText,
  toWebviewState,
};

async function configureSetting(setting: ConfigSettingName): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const current = stringValue(settings.get(setting)).trim();
  const options = configSettingOptions(setting);
  let nextValue: string | undefined;

  if (options.length) {
    const items: (vscode.QuickPickItem & { value?: string; custom?: boolean })[] = options.map((value) => ({
      label: value,
      value,
      description: value === current ? "current" : undefined,
    }));
    items.push({
      label: "Custom...",
      description: current ? `current: ${current}` : undefined,
      custom: true,
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: `Set ${configSettingLabel(setting)}`,
      placeHolder: current || "Pick a value",
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    nextValue = picked.custom
      ? await promptForConfigValue(setting, current)
      : picked.value ?? picked.label;
  } else {
    nextValue = await promptForConfigValue(setting, current);
  }

  const trimmed = stringValue(nextValue).trim();
  if (!trimmed || trimmed === current) {
    return;
  }
  await settings.update(setting, trimmed, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`English Training ${configSettingLabel(setting)} set to ${trimmed}.`);
  await refreshAll();
}

async function promptForConfigValue(setting: ConfigSettingName, current: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Set ${configSettingLabel(setting)}`,
    prompt: configSettingPrompt(setting),
    value: current,
    ignoreFocusOut: true,
  });
}

function configSettingLabel(setting: ConfigSettingName): string {
  switch (setting) {
    case "mimoCoachModel": return "MiMo coach model";
    case "openaiRealtimeTranscriptionModel": return "OpenAI Realtime speech-input model";
    case "openaiCoachModel": return "OpenAI coach model";
    case "geminiCoachModel": return "Gemini coach model";
    case "geminiAudioUnderstandingModel": return "Gemini speech-input model";
    case "minimaxTtsModel": return "MiniMax speech-output model";
    case "openaiTtsModel": return "OpenAI speech-output model";
    case "openaiTtsVoice": return "OpenAI voice";
    case "geminiTtsModel": return "Gemini speech-output model";
    case "geminiTtsVoice": return "Gemini voice";
  }
}

function configSettingPrompt(setting: ConfigSettingName): string {
  switch (setting) {
    case "openaiRealtimeTranscriptionModel": return "OpenAI Realtime transcription model id.";
    case "openaiTtsVoice": return "OpenAI TTS voice name.";
    case "geminiTtsVoice": return "Gemini prebuilt voice name.";
    default: return "Model id used by this provider.";
  }
}

function configSettingOptions(setting: ConfigSettingName): string[] {
  switch (setting) {
    case "mimoCoachModel": return ["mimo-v2.5-pro", "mimo-v2.5-flash"];
    case "openaiRealtimeTranscriptionModel": return ["gpt-realtime-whisper"];
    case "openaiCoachModel": return ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];
    case "geminiCoachModel": return GEMINI_TEXT_MODEL_OPTIONS;
    case "geminiAudioUnderstandingModel": return GEMINI_TEXT_MODEL_OPTIONS;
    case "minimaxTtsModel": return ["speech-2.8-hd", "speech-2.8-turbo"];
    case "openaiTtsModel": return ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
    case "openaiTtsVoice": return ["coral", "alloy", "ash", "ballad", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
    case "geminiTtsModel": return GEMINI_TTS_MODEL_OPTIONS;
    case "geminiTtsVoice": return ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
  }
}

function providerSetupHint(provider: ProviderName): string {
  switch (provider) {
    case "gemini": return "Gemini · default coach + speech input + native-version TTS";
    case "minimax": return "MiniMax · speech-output (TTS) provider";
    case "mimo": return "Xiaomi MiMo · coach + speech input + speech-output (Token Plan)";
    case "openai": return "OpenAI · coach + Realtime speech input + TTS";
  }
}
