import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  appendOutput,
  arrayOfStrings,
  config,
  errorMessage,
  stamp,
  stringValue,
  writeJson,
} from "../core.js";
import type {
  CoachPriorTurn,
  JsonObject,
  PracticeResult,
  StageReporter,
  TrainingState,
} from "../types.js";
import { coachTranscript } from "./coach.js";
import { transcribeAudio } from "./transcribe.js";
import {
  speechOutputExtension,
  speechOutputFileName,
  synthesizeWithConfiguredTts,
} from "./tts.js";

export async function processPracticeFile(
  context: vscode.ExtensionContext,
  state: TrainingState,
  inputPath: string,
  mimeType: string,
  sessionDir: string,
  packageDate: string,
  progress?: StageReporter,
  priorTurn?: CoachPriorTurn,
): Promise<PracticeResult> {
  progress?.("transcribe", "active");
  const transcript = await transcribeAudio(context, inputPath, mimeType, sessionDir);
  fs.writeFileSync(path.join(sessionDir, "transcript.txt"), `${transcript}\n`, "utf8");
  progress?.("transcribe", "done");

  progress?.("coach", "active");
  const coaching = await coachTranscript(context, state, transcript, priorTurn);
  const nativeVersion =
    stringValue(coaching.native_version) || stringValue(coaching.nativeVersion) || transcript;
  const problems = arrayOfStrings(coaching.problems).slice(0, 3);
  const quickFix = stringValue(coaching.quick_fix) || stringValue(coaching.quickFix);
  const followUpQuestion =
    stringValue(coaching.follow_up_question) || stringValue(coaching.followUpQuestion);
  const shadowingInstruction =
    stringValue(coaching.shadowing_instruction) ||
    stringValue(coaching.shadowingInstruction) ||
    `Repeat once: ${nativeVersion}`;
  const errorTags = normalizeErrorTags(coaching.error_tags ?? coaching.errorTags);
  const nextDrill =
    stringValue(coaching.next_drill) ||
    stringValue(coaching.nextDrill) ||
    nextDrillFromState(state, errorTags);
  const scores = ((coaching.scores as JsonObject | undefined) ?? {}) as JsonObject;
  progress?.("coach", "done");

  progress?.("tts", "active");
  const ttsProvider = config<string>("ttsProvider") || "minimax";
  const outputAudio = path.join(sessionDir, speechOutputFileName(ttsProvider));
  let audioFile: string | undefined;
  if (nativeVersion.trim()) {
    audioFile = (await synthesizeWithConfiguredTts(context, nativeVersion, outputAudio, ttsProvider))
      .filePath;
  }
  let followUpAudioFile: string | undefined;
  if (followUpQuestion.trim()) {
    const followUpPath = path.join(
      sessionDir,
      `follow-up.${speechOutputExtension(ttsProvider)}`,
    );
    try {
      followUpAudioFile = (
        await synthesizeWithConfiguredTts(context, followUpQuestion, followUpPath, ttsProvider)
      ).filePath;
    } catch (error) {
      appendOutput(`Follow-up TTS failed: ${errorMessage(error)}`);
    }
  }
  progress?.("tts", "done");

  progress?.("save", "active");
  const result: PracticeResult = {
    transcript,
    nativeVersion,
    problems,
    quickFix,
    followUpQuestion,
    shadowingInstruction,
    errorTags,
    nextDrill,
    scores,
    audioFile,
    followUpAudioFile,
    sessionDir,
    packageDate,
  };
  writeJson(path.join(sessionDir, "coach.json"), coaching);
  writeJson(path.join(sessionDir, "session.json"), {
    createdAt: new Date().toISOString(),
    packageDate,
    input: inputPath,
    result,
    settings: state.settings,
    drill: state.drill,
    sourceDiagnostics: state.sourceDiagnostics,
    learnerProfile: {
      loaded: state.learnerProfile.loaded,
      source: state.learnerProfile.source,
      summary: state.learnerProfile.summary,
    },
    priorTurn: priorTurn ?? null,
  });
  writeSessionMarkdown(path.join(sessionDir, "session.md"), state, result);
  appendSessionLog(state, inputPath, result, coaching);
  progress?.("save", "done");
  return result;
}

export function appendSessionLog(
  state: TrainingState,
  inputPath: string,
  result: PracticeResult,
  coaching: JsonObject,
): void {
  const entry = {
    schema_version: "vscode-session-log-v1",
    session_id: path.basename(result.sessionDir),
    created_at: new Date().toISOString(),
    date: state.today,
    package_date: result.packageDate,
    engine_type: "voice-5min",
    training_type: stringValue(state.training.training_type),
    scene: inferScene(state.training),
    primary_tags: arrayOfStrings(state.training.primary_tags),
    drill_types_used: drillTypesUsed(state),
    providers: {
      speech_in: state.settings.audioUnderstandingProvider,
      coach: state.settings.coachProvider,
      speech_out: state.settings.ttsProvider,
    },
    input_audio: inputPath,
    transcript: result.transcript,
    native_version: result.nativeVersion,
    problems: result.problems,
    error_tags: result.errorTags,
    scores: result.scores,
    quick_fix: result.quickFix,
    follow_up_question: result.followUpQuestion,
    shadowing_instruction: result.shadowingInstruction,
    next_drill: result.nextDrill,
    audio_file: result.audioFile,
    session_dir: result.sessionDir,
    raw_coaching: coaching,
  };
  const logPath = sessionLogPath(state.root);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  writeJson(path.join(state.root, "runtime", "vscode-sessions", "session-log-latest.json"), entry);
}

export function readRecentSessionLog(root: string, limit: number): JsonObject[] {
  const logPath = sessionLogPath(root);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  const recent: JsonObject[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      recent.push(JSON.parse(line) as JsonObject);
    } catch {
      continue;
    }
  }
  return recent;
}

export function sessionLogPath(root: string): string {
  return path.join(root, "runtime", "vscode-sessions", "session-log.jsonl");
}

export function inferScene(training: JsonObject): string {
  const scenario = `${stringValue(training.scenario)} ${stringValue(training.goal)}`.toLowerCase();
  if (
    scenario.includes("conference") ||
    scenario.includes("workshop") ||
    scenario.includes("seminar") ||
    scenario.includes("q&a")
  ) {
    return "S1";
  }
  if (scenario.includes("coffee") || scenario.includes("professor") || scenario.includes("network")) {
    return "S2";
  }
  return "S3";
}

export function drillTypesUsed(state: TrainingState): string[] {
  const method = stringValue(state.drill.method).toLowerCase();
  const used = new Set<string>();
  if (method.includes("substitution")) used.add("Substitution");
  if (method.includes("shadow")) used.add("Shadowing");
  const type = stringValue(state.training.training_type);
  if (type) used.add(type);
  if (used.size === 0) used.add("Voice-mode Free Chat");
  return Array.from(used);
}

export function normalizeErrorTags(value: unknown): string[] {
  const allowed = new Set(["[TA]", "[ART]", "[COUNT]", "[REF]", "[ORG]", "[LINK]", "[PRAG]", "[PROS]"]);
  return arrayOfStrings(value)
    .map((tag) => tag.trim().toUpperCase())
    .filter((tag) => allowed.has(tag))
    .slice(0, 3);
}

export function nextDrillFromState(state: TrainingState, errorTags: string[]): string {
  const frames = Array.isArray(state.training.frames)
    ? state.training.frames.map((item) => stringValue((item as JsonObject).text)).filter(Boolean)
    : [];
  const frame =
    frames[0] ||
    splitPracticeText(stringValue(state.training.clean_tts_text) || stringValue(state.training.audio_text))[0] ||
    "";
  const tagText = errorTags.length ? ` targeting ${errorTags.join(", ")}` : "";
  return frame
    ? `Do one FSI substitution loop${tagText}: repeat "${frame}", then replace one key phrase and say the full sentence again.`
    : `Do one FSI substitution loop${tagText}: keep the sentence frame stable and replace one slot quickly.`;
}

export function splitPracticeText(text: string): string[] {
  return text
    .replace(/<#\d+(?:\.\d+)?#>/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createSessionDir(root: string, packageDate: string): string {
  const dir = path.join(root, "runtime", "vscode-sessions", packageDate, stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSessionMarkdown(
  filePath: string,
  state: TrainingState,
  result: PracticeResult,
): void {
  const lines = [
    `# VS Code Practice Session`,
    ``,
    `- Date: ${state.today}`,
    `- Package: ${result.packageDate}`,
    `- Session: ${result.sessionDir}`,
    `- Source: ${state.sourceDiagnostics.currentJson || state.sourceLabel}`,
    `- Learner profile: ${state.learnerProfile.loaded ? state.learnerProfile.source : "missing"}`,
    ``,
    `## Task`,
    ``,
    stringValue(state.training.goal) || stringValue(state.next.goal),
    ``,
    `## Transcript`,
    ``,
    result.transcript,
    ``,
    `## Native Version`,
    ``,
    result.nativeVersion,
    ``,
    `## Problems`,
    ``,
    ...result.problems.map((item) => `- ${item}`),
    ``,
    `## Tags`,
    ``,
    ...(result.errorTags.length ? result.errorTags.map((item) => `- ${item}`) : ["- none"]),
    ``,
    `## Quick Fix`,
    ``,
    result.quickFix,
    ``,
    `## Next Drill`,
    ``,
    result.nextDrill,
    ``,
    `## Follow-up`,
    ``,
    result.followUpQuestion,
    ``,
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
