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
  DEEPSEEK_ANTHROPIC_BASE_URL,
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
import { buildPracticeHtml } from "./webview/html.js";
import { openMaterialsGuide } from "./materials-guide.js";

let statusProvider: StatusProvider;
let practiceProvider: PracticeViewProvider;
let nativeRecording: NativeRecordingSession | undefined;

const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const LOCAL_MICROPHONE_PATTERN = /\b(imac|macbook|mac mini|mac studio|studio display|built[- ]?in|internal)\b/i;
type ProviderSettingName = "coachProvider" | "audioUnderstandingProvider" | "ttsProvider";
type ConfigSettingName =
  | "minimaxCoachModel"
  | "mimoCoachModel"
  | "openaiCoachModel"
  | "openaiRealtimeTranscriptionModel"
  | "geminiCoachModel"
  | "kimiCoachModel"
  | "deepseekCoachModel"
  | "geminiAudioUnderstandingModel"
  | "minimaxTtsModel"
  | "openaiTtsModel"
  | "openaiTtsVoice"
  | "geminiTtsModel"
  | "geminiTtsVoice";

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

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("englishTraining.status", statusProvider));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("englishTraining.practice", practiceProvider));

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("englishTraining.openPractice", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.englishTraining");
    await vscode.commands.executeCommand("englishTraining.practice.focus");
  });
  register("englishTraining.refresh", async () => {
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
  register("englishTraining.configureKimiKey", async () => {
    await configureApiKey(context, "kimi");
  });
  register("englishTraining.configureDeepSeekKey", async () => {
    await configureApiKey(context, "deepseek");
  });
  register("englishTraining.clearApiKeys", async () => {
    await clearApiKeys(context);
  });
  register("englishTraining.useOpenAICoach", async () => {
    await setProviderSetting("coachProvider", "openai");
  });
  register("englishTraining.useGeminiCoach", async () => {
    await setProviderSetting("coachProvider", "gemini");
  });
  register("englishTraining.useMiniMaxCoach", async () => {
    await setProviderSetting("coachProvider", "minimax");
  });
  register("englishTraining.useMimoCoach", async () => {
    await setProviderSetting("coachProvider", "mimo");
  });
  register("englishTraining.useKimiCoach", async () => {
    await setProviderSetting("coachProvider", "kimi");
  });
  register("englishTraining.useDeepSeekCoach", async () => {
    await setProviderSetting("coachProvider", "deepseek");
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
  register("englishTraining.openMaterialsGuide", async () => {
    await openMaterialsGuide();
  });

  void refreshAll();
  void migrateGeminiModelDefaults();
}

export function deactivate(): void {
  if (nativeRecording && !nativeRecording.process.killed) {
    nativeRecording.process.kill("SIGTERM");
  }
}

export const __test__ = {
  buildProgressSnapshot,
  chooseLocalAvfoundationAudioDevice,
  dateRangeLabel,
  drillExamplesFromState,
  extensionFromMime,
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
  speechOutputExtension,
  todayExampleText,
  toWebviewState,
};

function pythonPath(): string {
  return config<string>("pythonPath") || "python3";
}

function trainingSettings(): TrainingState["settings"] {
  return {
    localMaterialsRoot: config<string>("localMaterialsRoot") || "",
    coachProvider: config<string>("coachProvider") || "gemini",
    audioUnderstandingProvider: normalizedSpeechInputProvider(),
    ttsProvider: config<string>("ttsProvider") || "gemini",
    openaiCoachModel: config<string>("openaiCoachModel") || "gpt-4o-mini",
    openaiRealtimeTranscriptionModel: config<string>("openaiRealtimeTranscriptionModel") || "gpt-realtime-whisper",
    geminiCoachModel: config<string>("geminiCoachModel") || "gemini-3-flash-preview",
    geminiTtsModel: config<string>("geminiTtsModel") || "gemini-3.1-flash-tts-preview",
    geminiTtsVoice: config<string>("geminiTtsVoice") || "Kore",
    geminiAudioUnderstandingModel: config<string>("geminiAudioUnderstandingModel") || "gemini-3-flash-preview",
    minimaxAnthropicBaseUrl: config<string>("minimaxAnthropicBaseUrl") || MINIMAX_ANTHROPIC_BASE_URL,
    minimaxCoachModel: config<string>("minimaxCoachModel") || "MiniMax-M2.7",
    mimoAnthropicBaseUrl: config<string>("mimoAnthropicBaseUrl") || MIMO_ANTHROPIC_BASE_URL,
    mimoCoachModel: config<string>("mimoCoachModel") || "mimo-v2.5-pro",
    kimiChatBaseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
    kimiCoachModel: config<string>("kimiCoachModel") || "kimi-for-coding",
    deepseekAnthropicBaseUrl: config<string>("deepseekAnthropicBaseUrl") || DEEPSEEK_ANTHROPIC_BASE_URL,
    deepseekCoachModel: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
    minimaxTtsModel: config<string>("minimaxTtsModel") || "speech-2.8-hd",
    minimaxTtsVoiceId: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
    ttsSpeed: normalizeTtsSpeed(config<unknown>("ttsSpeed"), 0.9),
    recorderBackend: config<string>("recorderBackend") || "macLocal",
    preferredMicrophoneName: config<string>("preferredMicrophoneName") || "",
    blockedMicrophoneNamePattern: config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN,
  };
}

function normalizedSpeechInputProvider(): string {
  const provider = config<string>("audioUnderstandingProvider") || "gemini";
  return provider === "openai" || provider === "gemini" ? provider : "gemini";
}

async function migrateGeminiModelDefaults(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await migrateProviderSetting(settings, "coachProvider", "minimax", "gemini");
  await migrateProviderSetting(settings, "audioUnderstandingProvider", "azure", "gemini");
  await migrateProviderSetting(settings, "ttsProvider", "minimax", "gemini");
  await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-flash", "gemini-3-flash-preview");
  await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-pro", "gemini-3.1-pro-preview");
  await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-flash", "gemini-3-flash-preview");
  await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-pro", "gemini-3.1-pro-preview");
  await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview");
  await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-pro-preview-tts", "gemini-3.1-flash-tts-preview");
  await refreshAll();
}

async function migrateProviderSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: ProviderSettingName,
  oldDefault: string,
  nextDefault: string,
): Promise<void> {
  const inspection = settings.inspect<string>(setting);
  const targets: Array<[string, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ].filter((entry): entry is [string, vscode.ConfigurationTarget] => entry[0] === oldDefault);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
}

async function migrateGeminiSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: "geminiCoachModel" | "geminiAudioUnderstandingModel" | "geminiTtsModel",
  oldDefault: string,
  nextDefault: string,
): Promise<void> {
  const inspection = settings.inspect<string>(setting);
  const targets: Array<[string, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ].filter((entry): entry is [string, vscode.ConfigurationTarget] => entry[0] === oldDefault);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
}

async function refreshAll(): Promise<void> {
  statusProvider.refresh();
  await practiceProvider.postState();
}

async function findTrainingRoot(): Promise<string> {
  const candidates: string[] = [];
  const configuredRoot = expandHome(config<string>("localMaterialsRoot") || "").trim();
  if (configuredRoot) {
    candidates.push(configuredRoot);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(folder.uri.fsPath);
    candidates.push(path.dirname(folder.uri.fsPath));
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    candidates.push(path.dirname(activeFile));
  }

  for (const start of candidates) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (looksLikeTrainingRoot(current)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error("Could not find an EnglishSpeakingTraining root with a prebuilt/ folder.");
}

function looksLikeTrainingRoot(root: string): boolean {
  return isDirectory(path.join(root, "prebuilt"));
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "", value.slice(2));
  }
  return value;
}

function todayInConfiguredTimezone(): string {
  const timezone = (config<string>("timezone") || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  } catch {
    appendOutput(`Invalid englishTraining.timezone "${timezone}", falling back to ${DEFAULT_TIMEZONE}.`);
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  }
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function execFile(root: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = cp.execFile(
      pythonPath(),
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 12,
      },
      (error, stdout, stderr) => {
        const exitError = error as NodeJS.ErrnoException | null;
        resolve({
          code: typeof exitError?.code === "number" ? exitError.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
  });
}

async function loadState(context: vscode.ExtensionContext): Promise<TrainingState> {
  const settings = trainingSettings();
  const today = todayInConfiguredTimezone();
  return loadLocalState(context, today, settings);
}

async function loadLocalState(
  context: vscode.ExtensionContext,
  today: string,
  settings: TrainingState["settings"],
): Promise<TrainingState> {
  const root = await findTrainingRoot();
  const next = await resolveNextPackage(root, today);
  const packageDate = stringValue(next.package_date);
  const training = packageDate ? readJson(path.join(root, "prebuilt", packageDate, "english-training.json")) ?? {} : {};
  const drill = packageDate ? buildDrillPlan(root, packageDate, training) : {};
  const trainingForState = packageDate
    ? { ...training, tts_example_text: todayExampleText(training, next) }
    : training;
  const inventory = readLocalInventory(root);
  const progress = buildProgressSnapshot(inventory.dates, inventory.completed, today, packageDate);
  const sourceDiagnostics = buildLocalSourceDiagnostics(root, settings, inventory, packageDate);

  return {
    root,
    source: "local",
    sourceLabel: root,
    today,
    next,
    training: trainingForState,
    drill,
    progress,
    sourceDiagnostics,
    learnerProfile: loadLocalLearnerProfile(root),
    recentSessions: readRecentSessionLog(root, 5),
    generatedAt: new Date().toISOString(),
    keys: await apiKeyAvailability(context),
    settings,
  };
}

function readLocalInventory(root: string): { dates: string[]; completed: Set<string> } {
  const prebuiltRoot = path.join(root, "prebuilt");
  const dates = fs.existsSync(prebuiltRoot)
    ? fs.readdirSync(prebuiltRoot)
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(prebuiltRoot, name)).isDirectory())
        .sort()
    : [];
  const progressJson = readJson(path.join(root, "progress", "english-speaking-training-progress.json")) ?? {};
  const completed = new Set<string>();
  for (const record of Array.isArray(progressJson.records) ? progressJson.records : []) {
    const item = record as JsonObject;
    if (stringValue(item.status) === "completed") {
      completed.add(stringValue(item.date));
    }
  }
  return { dates, completed };
}

function buildLocalSourceDiagnostics(
  root: string,
  settings: TrainingState["settings"],
  inventory: { dates: string[]; completed: Set<string> },
  packageDate: string,
): SourceDiagnostics {
  return {
    mode: "local",
    root,
    configuredRoot: settings.localMaterialsRoot,
    packageDir: packageDate ? path.join(root, "prebuilt", packageDate) : "",
    currentJson: packageDate ? path.join(root, "prebuilt", packageDate, "english-training.json") : "",
    currentPackageDate: packageDate,
    lessonCount: inventory.dates.length,
    completedCount: inventory.completed.size,
    dateRange: dateRangeLabel(inventory.dates),
  };
}

function dateRangeLabel(dates: string[]): string {
  if (!dates.length) {
    return "";
  }
  if (dates.length === 1) {
    return dates[0];
  }
  return `${dates[0]} to ${dates[dates.length - 1]}`;
}

function loadLocalLearnerProfile(root: string): LearnerProfile {
  const markdownPath = path.join(root, "profile", "learner-profile.md");
  if (fs.existsSync(markdownPath)) {
    return learnerProfileFromMarkdown(markdownPath, fs.readFileSync(markdownPath, "utf8"));
  }

  const jsonPath = path.join(root, "profile", "learner-profile.json");
  if (fs.existsSync(jsonPath)) {
    const profile = readJson(jsonPath);
    if (profile) {
      return learnerProfileFromJson(jsonPath, profile);
    }
  }

  return missingLearnerProfile(path.join(root, "profile", "learner-profile.md"));
}

function learnerProfileFromMarkdown(source: string, content: string): LearnerProfile {
  const summary = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 4)
    .join(" ");
  return {
    loaded: true,
    source,
    format: "markdown",
    summary: shortenText(summary || "Markdown learner profile loaded.", 260),
    content: shortenText(content.trim(), 5000),
  };
}

function learnerProfileFromJson(source: string, profile: JsonObject): LearnerProfile {
  const summaryParts = [
    profileFieldText(profile, ["name", "role", "identity"]),
    profileFieldText(profile, ["research_focus", "researchFocus", "focus"]),
    profileFieldText(profile, ["speaking_goals", "speakingGoals", "goals"]),
    profileFieldText(profile, ["coaching_preferences", "coachingPreferences", "preferences"]),
  ].filter(Boolean);
  return {
    loaded: true,
    source,
    format: "json",
    summary: shortenText(summaryParts.join(" "), 260) || "JSON learner profile loaded.",
    content: shortenText(JSON.stringify(profile, null, 2), 5000),
  };
}

function profileFieldText(profile: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => stringValue(item)).filter(Boolean);
      if (items.length) {
        return items.join("; ");
      }
    }
  }
  return "";
}

function missingLearnerProfile(source: string): LearnerProfile {
  return {
    loaded: false,
    source,
    format: "missing",
    summary: "Add profile/learner-profile.md or profile/learner-profile.json to personalize coaching.",
    content: "",
  };
}

function shortenText(value: string, maxLength: number): string {
  const text = value.replace(/\s+$/g, "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildProgressSnapshot(
  dates: string[],
  completed: Set<string>,
  today: string,
  currentPackageDate: string,
): ProgressSnapshot {
  const total = dates.length;
  const completedCount = dates.filter((d) => completed.has(d)).length;
  const indexOfCurrent = currentPackageDate ? dates.indexOf(currentPackageDate) : -1;
  const currentIndex = indexOfCurrent >= 0 ? indexOfCurrent + 1 : 0;

  let lastTodayIdx = -1;
  for (let i = 0; i < dates.length; i += 1) {
    if (dates[i] <= today) {
      lastTodayIdx = i;
    } else {
      break;
    }
  }
  let streak = 0;
  for (let i = lastTodayIdx; i >= 0; i -= 1) {
    if (completed.has(dates[i])) {
      streak += 1;
    } else {
      break;
    }
  }

  const weekIndex = currentIndex ? Math.ceil(currentIndex / 7) : 0;
  const dayInWeek = currentIndex ? ((currentIndex - 1) % 7) + 1 : 0;
  const weekStart = currentIndex ? (weekIndex - 1) * 7 : 0;
  const weekDates = dates.slice(weekStart, weekStart + 7);
  const weekTotalDays = weekDates.length;
  const weekCompletedDays = weekDates.filter((d) => completed.has(d)).length;

  const cells: ProgressCell[] = dates.map((date) => {
    if (completed.has(date)) {
      return { date, status: "completed" };
    }
    if (date === currentPackageDate) {
      return { date, status: "current" };
    }
    if (date < today) {
      return { date, status: "missed" };
    }
    return { date, status: "pending" };
  });

  return {
    total,
    completedCount,
    currentIndex,
    streak,
    weekIndex,
    dayInWeek,
    weekTotalDays,
    weekCompletedDays,
    cells,
  };
}

async function resolveNextPackage(root: string, today: string): Promise<JsonObject> {
  const script = path.join(root, "scripts", "english_training_progress.py");
  if (fs.existsSync(script)) {
    const result = await execFile(root, ["scripts/english_training_progress.py", "next", "--as-of", today], 60_000);
    const parsed = parseFirstJson(result.stdout);
    const next = ((parsed?.result as JsonObject | undefined) ?? {}) as JsonObject;
    if (stringValue(next.package_date)) {
      return next;
    }
  }

  const prebuiltRoot = path.join(root, "prebuilt");
  const dates = fs
    .readdirSync(prebuiltRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(prebuiltRoot, name)).isDirectory())
    .sort();
  const progress = readJson(path.join(root, "progress", "english-speaking-training-progress.json")) ?? {};
  const completed = new Set<string>();
  for (const record of Array.isArray(progress.records) ? progress.records : []) {
    const item = record as JsonObject;
    if (stringValue(item.status) === "completed") {
      completed.add(stringValue(item.date));
    }
  }
  const packageDate = dates.find((date) => !completed.has(date)) ?? dates[dates.length - 1] ?? "";
  const training = packageDate ? readJson(path.join(prebuiltRoot, packageDate, "english-training.json")) ?? {} : {};
  return {
    send_date: today,
    package_date: packageDate,
    completion_label: packageDate ? `Package ${dates.indexOf(packageDate) + 1}` : "",
    package_day_index: packageDate ? dates.indexOf(packageDate) + 1 : undefined,
    training_type: stringValue(training.training_type),
    goal: stringValue(training.goal),
    scenario: stringValue(training.scenario),
    clean_tts_text: stringValue(training.clean_tts_text) || stringValue(training.audio_text),
    assets: packageDate ? packageAssets(root, packageDate) : {},
  };
}

function packageAssets(root: string, packageDate: string): JsonObject {
  const dir = path.join(root, "prebuilt", packageDate);
  const manifest = readJson(path.join(dir, "manifest.json")) ?? {};
  const files = (manifest.files && typeof manifest.files === "object" ? manifest.files : {}) as JsonObject;
  return {
    package_dir: dir,
    task_card: resolvePackageAsset(dir, files, ["telegram_task_card", "task_card"], "telegram-task-card.md"),
    daily_card: resolvePackageAsset(dir, files, ["daily_card"], "daily-card.png"),
    prosody_detail: resolvePackageAsset(dir, files, ["prosody_detail"], "prosody-detail.png"),
    demo_audio: resolvePackageAsset(dir, files, ["audio_demo", "demo_audio", "audio"], path.join("audio", "demo.ogg")),
    json: resolvePackageAsset(dir, files, ["json"], "english-training.json"),
    followup_drill_json: resolvePackageAsset(dir, files, ["followup_drill_json"], "followup-drill.json"),
    followup_drill_md: resolvePackageAsset(dir, files, ["followup_drill_md"], "followup-drill.md"),
    audio_queue: resolvePackageAsset(dir, files, ["audio_queue"], "audio-queue.json"),
    validation_report: resolvePackageAsset(dir, files, ["validation_report"], "validation-report.json"),
    manifest: path.join(dir, "manifest.json"),
  };
}

function resolvePackageAsset(
  packageDir: string,
  manifestFiles: JsonObject,
  keys: string[],
  fallbackRelativePath: string,
): string {
  const fromManifest = keys
    .map((key) => stringValue(manifestFiles[key]).trim())
    .find(Boolean);
  const candidate = fromManifest || fallbackRelativePath;
  if (!candidate) {
    return "";
  }
  if (isHttpUrl(candidate) || path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(packageDir, candidate);
}

function todayExampleText(training: JsonObject, next: JsonObject = {}): string {
  const direct = [
    stringValue(training.tts_example_text),
    stringValue(training.clean_tts_text),
    stringValue(training.audio_text),
    stringValue(training.demo_line),
    stringValue(next.clean_tts_text),
    stringValue(next.audio_text),
    stringValue(next.demo_line),
  ]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (direct) {
    return direct;
  }
  return spokenFrameTexts(training.frames).join(" ").trim();
}

function spokenFrameTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "object" && item) {
        return stringValue((item as JsonObject).text);
      }
      return stringValue(item);
    })
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildDrillPlan(root: string, packageDate: string, training: JsonObject): JsonObject {
  const followupPath = path.join(root, "prebuilt", packageDate, "followup-drill.json");
  const followup = readJson(followupPath) ?? {};
  const task = (training.task as JsonObject | undefined) ?? {};
  const primaryTags = arrayOfStrings(training.primary_tags);
  const fallbackFrames = Array.isArray(training.frames)
    ? [
        {
          id: "A",
          label: "Substitution: today's frames",
          base_frame: stringValue((training.frames[0] as JsonObject | undefined)?.text) || stringValue(training.clean_tts_text),
          slot: "frame",
          examples: training.frames,
        },
      ]
    : [];

  return {
    title: stringValue(followup.title) || `FSI Drill - ${packageDate}`,
    method: stringValue(followup.method) || "FSI-style substitution + shadowing",
    routine_zh: arrayOfStrings(followup.routine_zh).length
      ? arrayOfStrings(followup.routine_zh)
      : [
          "先听一遍，不分析语法。",
          "用完整句快速替换 cue。",
          "延迟 0.5-1 秒跟读，复制节奏和停顿。",
          "最后不看文本说两句。",
        ],
    rounds: Array.isArray(followup.rounds) ? followup.rounds : fallbackFrames,
    shadowing_loop: (followup.shadowing_loop as JsonObject | undefined) ?? {
      chunks: splitPracticeText(stringValue(training.clean_tts_text) || stringValue(training.audio_text)).slice(0, 4),
      instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
    },
    source_principles: arrayOfStrings(followup.source_principles),
    repair_drills: arrayOfStrings(training.repair_drills),
    primary_tags: primaryTags,
    required_frames: Number(task.required_frames ?? 0) || undefined,
    training_type: stringValue(training.training_type),
  };
}

async function apiKeyAvailability(context: vscode.ExtensionContext): Promise<KeyAvailability> {
  return {
    openai: Boolean(await context.secrets.get(secretKeys.openai)),
    gemini: Boolean(await context.secrets.get(secretKeys.gemini)),
    minimax: Boolean(await context.secrets.get(secretKeys.minimax)),
    mimo: Boolean(await context.secrets.get(secretKeys.mimo)),
    kimi: Boolean(await context.secrets.get(secretKeys.kimi)),
    deepseek: Boolean(await context.secrets.get(secretKeys.deepseek)),
  };
}

async function configureApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<void> {
  const label = providerLabel(provider);
  const value = await vscode.window.showInputBox({
    title: `Configure ${label} API Key`,
    prompt: `Paste the ${label} API key. It will be stored in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  await context.secrets.store(secretKeys[provider], value.trim());
  vscode.window.showInformationMessage(`${label} API key saved.`);
  await refreshAll();
}

async function pickAndConfigureProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const providers: ProviderName[] = ["gemini", "openai", "minimax", "mimo", "kimi", "deepseek"];
  const availability = await apiKeyAvailability(context);
  const items: (vscode.QuickPickItem & { provider: ProviderName })[] = providers.map((provider) => ({
    provider,
    label: providerLabel(provider),
    description: availability[provider] ? "saved" : "not set",
    detail: providerSetupHint(provider),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Set up an AI provider key",
    placeHolder: "Pick a provider to configure (you only need one to start)",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await configureApiKey(context, picked.provider);
}

async function configureCoreRouteKeys(context: vscode.ExtensionContext): Promise<void> {
  const availability = await apiKeyAvailability(context);
  if (!availability.gemini) {
    await configureApiKey(context, "gemini");
  }
}

function isConfigSettingName(value: unknown): value is ConfigSettingName {
  return (
    value === "minimaxCoachModel" ||
    value === "mimoCoachModel" ||
    value === "openaiCoachModel" ||
    value === "openaiRealtimeTranscriptionModel" ||
    value === "geminiCoachModel" ||
    value === "kimiCoachModel" ||
    value === "deepseekCoachModel" ||
    value === "geminiAudioUnderstandingModel" ||
    value === "minimaxTtsModel" ||
    value === "openaiTtsModel" ||
    value === "openaiTtsVoice" ||
    value === "geminiTtsModel" ||
    value === "geminiTtsVoice"
  );
}

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
    case "minimaxCoachModel": return "MiniMax coach model";
    case "mimoCoachModel": return "MiMo coach model";
    case "openaiCoachModel": return "OpenAI coach model";
    case "openaiRealtimeTranscriptionModel": return "OpenAI Realtime speech-input model";
    case "geminiCoachModel": return "Gemini coach model";
    case "kimiCoachModel": return "Kimi coach model";
    case "deepseekCoachModel": return "DeepSeek coach model";
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
    case "minimaxCoachModel": return ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"];
    case "mimoCoachModel": return ["mimo-v2.5-pro", "mimo-v2.5-flash"];
    case "openaiCoachModel": return ["gpt-4o-mini", "gpt-4o"];
    case "openaiRealtimeTranscriptionModel": return ["gpt-realtime-whisper"];
    case "geminiCoachModel": return GEMINI_TEXT_MODEL_OPTIONS;
    case "kimiCoachModel": return ["kimi-for-coding"];
    case "deepseekCoachModel": return ["deepseek-v4-pro", "deepseek-v4-flash"];
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
    case "gemini": return "Gemini · default coach + native-version TTS";
    case "minimax": return "MiniMax · optional fallback coach + TTS";
    case "mimo": return "Xiaomi MiMo · alternate coach (Token Plan, Anthropic-compatible)";
    case "openai": return "OpenAI · GPT coach + Realtime speech input + TTS";
    case "kimi": return "Kimi (Moonshot) · alternate coach";
    case "deepseek": return "DeepSeek · alternate coach (Anthropic-compatible)";
  }
}

async function clearApiKeys(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage("Clear all English Training API keys from VS Code SecretStorage?", { modal: true }, "Clear");
  if (choice !== "Clear") {
    return;
  }
  await Promise.all(Object.values(secretKeys).map((key) => context.secrets.delete(key)));
  vscode.window.showInformationMessage("English Training API keys cleared.");
  await refreshAll();
}

async function configureLocalMaterialsRoot(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this local folder for English Training",
    title: "Choose Local English Training Materials Folder",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  const config = vscode.workspace.getConfiguration("englishTraining");
  await config.update("localMaterialsRoot", root, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`English Training local materials folder set to ${root}.`);
  await refreshAll();
}

async function setProviderSetting(setting: ProviderSettingName, value: string): Promise<void> {
  await vscode.workspace.getConfiguration("englishTraining").update(setting, value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider set to ${value}.`);
  await refreshAll();
}

async function setGeminiOnlyProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("coachProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("audioUnderstandingProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("ttsProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("English Training Gemini-only mode enabled: Gemini coach + speech input + speech output.");
  await refreshAll();
}

async function setRecommendedHybridProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("coachProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("audioUnderstandingProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("ttsProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("English Training recommended route enabled: Gemini coach + Gemini speech input + Gemini speech output.");
  await refreshAll();
}

async function setTtsSpeedConfig(speed: number): Promise<void> {
  const clamped = normalizeTtsSpeed(speed, 0.9);
  await vscode.workspace.getConfiguration("englishTraining").update("ttsSpeed", clamped, vscode.ConfigurationTarget.Workspace);
  await refreshAll();
}

async function setMinimaxVoiceId(voiceId: string, pinTurbo: boolean): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("minimaxTtsVoiceId", voiceId, vscode.ConfigurationTarget.Workspace);
  if (pinTurbo) {
    const currentModel = settings.get<string>("minimaxTtsModel") || "speech-2.8-hd";
    if (currentModel !== "speech-2.8-turbo") {
      await settings.update("minimaxTtsModel", "speech-2.8-turbo", vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(
        `MiniMax voice set to ${voiceId} (cloned voice — pinned model to speech-2.8-turbo to avoid HD billing).`,
      );
      await refreshAll();
      return;
    }
  }
  vscode.window.showInformationMessage(`MiniMax voice set to ${voiceId}.`);
  await refreshAll();
}

function providerSettingLabel(setting: ProviderSettingName): string {
  if (setting === "coachProvider") return "coach";
  if (setting === "audioUnderstandingProvider") return "speech input";
  return "speech output";
}

class PracticeViewProvider implements vscode.WebviewViewProvider {
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
        }
        if (payload.setting === "audioUnderstandingProvider" && isAudioUnderstandingProvider(payload.value)) {
          await setProviderSetting("audioUnderstandingProvider", payload.value);
        }
        if (payload.setting === "ttsProvider" && isTtsProvider(payload.value)) {
          await setProviderSetting("ttsProvider", payload.value);
        }
        return;
      }
      if (payload.type === "configureSetting" && isConfigSettingName(payload.setting)) {
        await configureSetting(payload.setting);
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
    const session = await startNativeFfmpegRecording(this.context, practiceTarget);
    this.view.webview.postMessage({
      type: "nativeRecordingStarted",
      sessionDir: session.sessionDir,
    });
  }

  private async stopNativeRecording(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "stage", stage: "transcribe", status: "active", show: true });
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

function toWebviewState(webview: vscode.Webview, state: TrainingState): JsonObject {
  const next = { ...state.next };
  const assets = { ...((next.assets as JsonObject | undefined) ?? {}) };
  for (const [key, value] of Object.entries(assets)) {
    const filePath = stringValue(value);
    if (isHttpUrl(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      assets[`${key}_uri`] = filePath;
    } else if (filePath && fs.existsSync(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      assets[`${key}_uri`] = webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
    }
  }
  next.assets = assets;
  return {
    ...state,
    next,
  };
}

async function processPracticeAudio(
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

function normalizePracticeTargetPayload(value: unknown): PracticeTarget | undefined {
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

async function startNativeFfmpegRecording(
  context: vscode.ExtensionContext,
  practiceTarget?: PracticeTarget,
): Promise<NativeRecordingSession> {
  if (nativeRecording) {
    throw new Error("Native recorder is already running.");
  }
  if (process.platform !== "darwin") {
    throw new Error("Native recorder fallback currently supports macOS AVFoundation only.");
  }

  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const filePath = path.join(sessionDir, "native-input.wav");
  const ffmpegPath = resolveFfmpegPath();
  const device = resolveNativeFfmpegAudioDevice(ffmpegPath);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    `:${device}`,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    filePath,
  ];

  const stderr: string[] = [];
  let spawnError: Error | undefined;
  const child = cp.spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] }) as cp.ChildProcessWithoutNullStreams;
  const session: NativeRecordingSession = {
    process: child,
    filePath,
    sessionDir,
    packageDate,
    practiceTarget,
    startedAt: Date.now(),
    stderr,
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (text.trim()) {
      appendOutput(text.trim());
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr.push(text);
    if (text.trim()) {
      appendOutput(text.trim());
    }
  });
  child.on("error", (error) => {
    spawnError = error;
    stderr.push(error.message);
    if (nativeRecording === session) {
      nativeRecording = undefined;
    }
  });
  child.on("exit", (code, signal) => {
    if (nativeRecording === session) {
      nativeRecording = undefined;
    }
    appendOutput(`Native ffmpeg recorder exited with code=${code ?? "null"} signal=${signal ?? "null"}.`);
  });

  nativeRecording = session;
  appendOutput(`Starting native recorder: ${ffmpegPath} ${args.join(" ")}`);
  await delay(900);
  if (spawnError) {
    nativeRecording = undefined;
    throw new Error(`Native recorder failed to start: ${spawnError.message}`);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    nativeRecording = undefined;
    throw new Error(nativeRecorderError(session, "Native recorder exited before it could start."));
  }

  return session;
}

async function stopNativeFfmpegRecording(): Promise<NativeRecordingSession> {
  const session = nativeRecording;
  if (!session) {
    throw new Error("Native recorder is not running.");
  }
  nativeRecording = undefined;

  const child = session.process;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("q\n");
      }
    } catch {
      // Fall through to signal-based shutdown.
    }
  }

  let exited = await waitForExit(child, 2500);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    exited = await waitForExit(child, 1500);
  }
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 1000);
  }

  await delay(150);
  let size = 0;
  try {
    size = fs.statSync(session.filePath).size;
  } catch {
    size = 0;
  }
  if (size < 1000) {
    throw new Error(nativeRecorderError(session, "Native recorder did not produce a usable audio file."));
  }
  appendOutput(`Native recording saved: ${session.filePath} (${size} bytes, ${Math.round((Date.now() - session.startedAt) / 1000)}s)`);
  return session;
}

function resolveNativeFfmpegAudioDevice(ffmpegPath: string): string {
  const configured = (config<string>("nativeRecorderFfmpegAudioDevice") || "auto").trim() || "auto";
  if (configured.toLowerCase() !== "auto") {
    appendOutput(`Using configured native audio device: ${configured}`);
    return configured;
  }

  const devices = listAvfoundationAudioDevices(ffmpegPath);
  const chosen = chooseLocalAvfoundationAudioDevice(devices);
  if (!chosen) {
    const listed = devices.length
      ? devices.map((device) => `[${device.index}] ${device.name}`).join(", ")
      : "none";
    throw new Error(
      `No allowed Mac local microphone was found. AVFoundation audio devices: ${listed}. ` +
      `Set englishTraining.preferredMicrophoneName or englishTraining.nativeRecorderFfmpegAudioDevice explicitly if needed.`,
    );
  }
  appendOutput(`Selected Mac local microphone [${chosen.index}] ${chosen.name}`);
  return chosen.index;
}

function listAvfoundationAudioDevices(ffmpegPath: string): AvfoundationAudioDevice[] {
  const result = cp.spawnSync(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not run ffmpeg at "${ffmpegPath}": ${result.error.message}`);
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return parseAvfoundationAudioDevices(text);
}

function parseAvfoundationAudioDevices(text: string): AvfoundationAudioDevice[] {
  const devices: AvfoundationAudioDevice[] = [];
  let inAudioSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("AVFoundation audio devices:")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("AVFoundation video devices:")) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) {
      continue;
    }
    const match = line.match(/\]\s*\[(\d+)\]\s+(.+)$/);
    if (match) {
      devices.push({ index: match[1], name: match[2].trim() });
    }
  }
  return devices;
}

function chooseLocalAvfoundationAudioDevice(devices: AvfoundationAudioDevice[]): AvfoundationAudioDevice | undefined {
  const blocked = blockedMicrophoneRegex();
  const allowed = devices.filter((device) => !blocked.test(device.name));
  const preferredName = (config<string>("preferredMicrophoneName") || "").trim().toLowerCase();
  if (preferredName) {
    const preferred = allowed.find((device) => device.name.toLowerCase().includes(preferredName));
    if (preferred) {
      return preferred;
    }
  }
  return allowed.find((device) => LOCAL_MICROPHONE_PATTERN.test(device.name)) ?? allowed[0];
}

function blockedMicrophoneRegex(): RegExp {
  const pattern = (config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN).trim()
    || DEFAULT_BLOCKED_MICROPHONE_PATTERN;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(DEFAULT_BLOCKED_MICROPHONE_PATTERN, "i");
  }
}

function nativeRecorderError(session: NativeRecordingSession, summary: string): string {
  const detail = session.stderr.join("").trim();
  const hint = `Check macOS microphone permission for VS Code/ffmpeg, or set englishTraining.preferredMicrophoneName / englishTraining.nativeRecorderFfmpegAudioDevice after running: ffmpeg -f avfoundation -list_devices true -i ""`;
  return `${summary}${detail ? `\n${detail.slice(0, 1200)}` : ""}\n${hint}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: cp.ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

function createReferenceAudioDir(root: string, packageDate: string): string {
  const dir = path.join(root, "runtime", "vscode-reference-audio", packageDate);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function synthesizeTodayAudio(context: vscode.ExtensionContext): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const text = todayExampleText(state.training, state.next);
  if (!text.trim()) {
    throw new Error("No example text is available for today's package. Add clean_tts_text, audio_text, demo_line, or frames[].text.");
  }
  const provider = config<string>("ttsProvider") || "gemini";
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `today-${stamp()}.${speechOutputExtension(provider)}`);
  const result = await synthesizeWithConfiguredTts(context, text, outPath, provider);
  const audio = fs.readFileSync(result.filePath);
  const mimeType = mimeTypeForAudioPath(result.filePath);
  return {
    provider: result.provider,
    packageDate,
    text,
    filePath: result.filePath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}

async function synthesizeOnDemandText(
  context: vscode.ExtensionContext,
  text: string,
  speed: number,
): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const provider = config<string>("ttsProvider") || "gemini";
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `slow-${stamp()}.${speechOutputExtension(provider)}`);
  const result = await synthesizeWithConfiguredTts(context, text, outPath, provider, speed);
  const audio = fs.readFileSync(result.filePath);
  const mimeType = mimeTypeForAudioPath(result.filePath);
  return {
    provider: result.provider,
    speed,
    text,
    filePath: result.filePath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}

async function completeLocalPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date);
  if (!packageDate) {
    throw new Error("No current package to complete.");
  }
  const script = path.join(state.root, "scripts", "english_training_progress.py");
  if (!fs.existsSync(script)) {
    throw new Error("Local completion requires scripts/english_training_progress.py in this workspace.");
  }
  const result = await execFile(state.root, [
    "scripts/english_training_progress.py",
    "complete",
    "--date",
    packageDate,
    "--due-date",
    state.today,
    "--no-todoist",
    "--note",
    "Completed in VS Code local practice.",
  ], 90_000);
  showOutput(true);
  appendOutput(`\n$ ${pythonPath()} scripts/english_training_progress.py complete --date ${packageDate} --due-date ${state.today} --no-todoist`);
  appendOutput(result.stdout.trim());
  if (result.stderr.trim()) appendOutput(result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`Local completion failed: ${result.stderr || result.stdout}`);
  }
  vscode.window.showInformationMessage(`Completed ${packageDate} locally.`);
  await refreshAll();
}

async function openCurrentTaskCard(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const taskCard = stringValue(assets.task_card);
  if (taskCard && isHttpUrl(taskCard)) {
    await vscode.env.openExternal(vscode.Uri.parse(taskCard));
    return;
  }
  const localTaskCard = existingFilePath(taskCard);
  const currentJson = existingFilePath(state.sourceDiagnostics.currentJson);
  const target = localTaskCard || currentJson;
  if (!target) {
    throw new Error("No task card or english-training.json path is available.");
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

async function revealCurrentPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const packageDir = stringValue(assets.package_dir);
  if (!packageDir) {
    throw new Error("No package directory is available.");
  }
  if (isHttpUrl(packageDir)) {
    await vscode.env.openExternal(vscode.Uri.parse(packageDir));
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(packageDir));
}

async function openSessionFolder(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const dir = path.join(state.root, "runtime", "vscode-sessions");
  fs.mkdirSync(dir, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}

async function createSamplePackage(context: vscode.ExtensionContext): Promise<void> {
  const root = await resolveOrBootstrapLocalRoot();
  if (!root) {
    return;
  }
  const today = todayInConfiguredTimezone();
  const dateInput = await vscode.window.showInputBox({
    title: "Create Sample Package",
    prompt: "Lesson date (YYYY-MM-DD). Defaults to today.",
    value: today,
    ignoreFocusOut: true,
    validateInput: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? null : "Use YYYY-MM-DD format.",
  });
  if (!dateInput) {
    return;
  }
  const targetDate = dateInput.trim();
  const packageDir = path.join(root, "prebuilt", targetDate);
  const targetFile = path.join(packageDir, "english-training.json");
  if (fs.existsSync(targetFile)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDate}/english-training.json already exists. Overwrite?`,
      { modal: true },
      "Overwrite",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(targetFile, sampleTrainingPackage(targetDate));
  writeJson(path.join(packageDir, "followup-drill.json"), sampleFollowupDrillPackage(targetDate));
  vscode.window.showInformationMessage(`Sample lesson and FSI drill written to prebuilt/${targetDate}. Edit them and refresh the sidebar.`);
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
  await refreshAll();
}

async function resolveOrBootstrapLocalRoot(): Promise<string | undefined> {
  try {
    return await findTrainingRoot();
  } catch {
    // fall through to bootstrap flow
  }
  const choice = await vscode.window.showInformationMessage(
    "No local materials folder found. Pick a folder to host your lessons — the extension will create prebuilt/ and progress/ inside it.",
    { modal: true },
    "Pick Folder",
    "Open Guide",
  );
  if (choice === "Open Guide") {
    await openMaterialsGuide();
    return undefined;
  }
  if (choice !== "Pick Folder") {
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this folder for English Training materials",
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  await vscode.workspace.getConfiguration().update("englishTraining.localMaterialsRoot", root, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`English Training materials root set to ${root}.`);
  return root;
}

function sampleTrainingPackage(date: string): JsonObject {
  return {
    date,
    training_type: "input",
    primary_tags: ["OPEN", "LINK"],
    scenario: "You're at a conference coffee break. Someone asks: \"So what kind of work do you do?\"",
    goal: "Give a natural 30-second introduction to your role and one thing you're working on right now.",
    chinese_setup: "用 30-45 秒自然介绍你做什么、最近在忙什么。像茶歇里答复别人问题，不要像念简历。",
    frames: [
      { label: "Frame 1", text: "I work on [topic] at [team or context].", function: "spoken frame" },
      { label: "Frame 2", text: "Right now I'm especially focused on [current project].", function: "spoken frame" },
      { label: "Frame 3", text: "More broadly, I'm interested in [bigger question].", function: "spoken frame" },
    ],
    demo_line:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    audio_text:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    clean_tts_text:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    stress_guide:
      "I ˈWORK on ˈLEGAL ˈISSUES around ˈAI and ˈPLATFORMS. ˈRIGHT ˈNOW I'm ˈESPECIALLY ˈFOCUSED on ˈUSER-AUTHORIZED ˈAGENTS. ˈMORE ˈBROADLY, I'm ˈINTERESTED in how ˈLAW should ˈRESPOND when ˈTECHNOLOGY ˈCHANGES who ˈACTS and who ˈCONTROLS.",
    intonation_guide:
      "I work on legal issues around AI and platforms. → | Right now I'm especially focused on user-authorized agents. → | More broadly, I'm interested in how law should respond when technology changes who acts and who controls. ↘",
    word_level_prosody: {
      groups: [
        {
          id: 1,
          text: "I work on legal issues around AI and platforms.",
          function: "statement",
          nucleus: "platforms.",
          contour: "→",
          pause_after: "short",
        },
        {
          id: 2,
          text: "Right now I'm especially focused on user-authorized agents.",
          function: "statement",
          nucleus: "agents.",
          contour: "→",
          pause_after: "short",
        },
        {
          id: 3,
          text: "More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
          function: "statement",
          nucleus: "controls.",
          contour: "↘",
          pause_after: "final",
        },
      ],
      words: [
        { text: "I", stress: "weak", pitch_role: "unstressed", arrow: "", group: 1 },
        { text: "work", stress: "support", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "legal", stress: "support", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "AI", stress: "support", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "platforms.", stress: "nucleus", pitch_role: "level continuation", arrow: "→", group: 1 },
        { text: "Right", stress: "support", pitch_role: "support beat", arrow: "", group: 2 },
        { text: "focused", stress: "support", pitch_role: "support beat", arrow: "", group: 2 },
        { text: "agents.", stress: "nucleus", pitch_role: "level continuation", arrow: "→", group: 2 },
        { text: "More", stress: "support", pitch_role: "support beat", arrow: "", group: 3 },
        { text: "law", stress: "support", pitch_role: "support beat", arrow: "", group: 3 },
        { text: "respond", stress: "support", pitch_role: "support beat", arrow: "", group: 3 },
        { text: "controls.", stress: "nucleus", pitch_role: "falling target", arrow: "↘", group: 3 },
      ],
    },
    notes: [
      "This is a starter sample. Edit scenario, goal, frames, and clean_tts_text for your own lesson.",
      "Add stress_guide, intonation_guide, or word_level_prosody for richer prosody coaching.",
      "Use the Example audio button in the sidebar to generate reference TTS from the example only.",
    ],
  };
}

function sampleFollowupDrillPackage(date: string): JsonObject {
  return {
    schema_version: 1,
    date,
    title: `Post-practice Speaking Drill - ${date}`,
    method: "FSI-style substitution + shadowing",
    source_principles: [
      "Stable base sentence plus fast slot replacement.",
      "Full-sentence output for each cue; do not answer with fragments.",
      "Shadow the audio with 0.5-1 second delay, then say selected lines from memory.",
    ],
    routine_zh: [
      "先看例句，不分析语法。",
      "听一遍，只抓节奏和停顿。",
      "点击 Practice 后完整跟读目标句。",
      "最后任选两句，不看文本直接说出来。",
    ],
    rounds: [
      {
        id: "A",
        label: "Substitution: role and project",
        base_frame: "I work on legal issues around AI and platforms.",
        slot: "topic / project",
        examples: [
          { cue: "topic", text: "I work on legal issues around AI and platforms." },
          { cue: "current project", text: "Right now I'm especially focused on user-authorized agents." },
          { cue: "broader question", text: "More broadly, I'm interested in how law should respond when technology changes who acts and who controls." },
        ],
      },
      {
        id: "B",
        label: "Substitution: claim and example",
        base_frame: "My claim is that authorization should matter when platforms decide whether to block an agent.",
        slot: "claim / example",
        examples: [
          { cue: "claim", text: "My claim is that authorization should matter when platforms decide whether to block an agent." },
          { cue: "example", text: "A concrete example is when a useful agent gets blocked because the platform treats it like abuse." },
          { cue: "repair", text: "Let me put the point more narrowly." },
        ],
      },
    ],
    shadowing_loop: {
      chunks: [
        "I work on legal issues around AI and platforms.",
        "Right now I'm especially focused on user-authorized agents.",
        "My claim is that authorization should matter when platforms decide whether to block an agent.",
      ],
      instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
    },
  };
}

class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    description?: string,
    command?: vscode.Command,
    tooltip?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.command = command;
    this.tooltip = tooltip || [label, description].filter(Boolean).join(": ");
  }
}

class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private readonly changed = new vscode.EventEmitter<StatusItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<StatusItem[]> {
    try {
      const state = await loadState(this.context);
      const next = state.next;
      const diagnostics = state.sourceDiagnostics;
      const profile = state.learnerProfile;
      return [
        new StatusItem(`${stringValue(next.completion_label) || "Current"} ${stringValue(next.package_date)}`, vscode.TreeItemCollapsibleState.None, stringValue(next.training_type)),
        new StatusItem("Source", vscode.TreeItemCollapsibleState.None, "local", { command: "englishTraining.configureLocalMaterials", title: "Configure Local Materials Folder" }),
        new StatusItem("Materials Root", vscode.TreeItemCollapsibleState.None, compactStatusValue(diagnostics.root), undefined, diagnostics.root),
        new StatusItem("Lessons", vscode.TreeItemCollapsibleState.None, `${diagnostics.lessonCount} total${diagnostics.dateRange ? ` · ${diagnostics.dateRange}` : ""}`),
        new StatusItem("Current JSON", vscode.TreeItemCollapsibleState.None, compactStatusValue(diagnostics.currentJson), { command: "englishTraining.revealPackage", title: "Reveal Current Package" }, diagnostics.currentJson),
        new StatusItem("Profile", vscode.TreeItemCollapsibleState.None, profile.loaded ? "loaded" : "missing", undefined, `${profile.loaded ? "Loaded" : "Missing"}: ${profile.source}`),
        new StatusItem("Coach", vscode.TreeItemCollapsibleState.None, state.settings.coachProvider),
        new StatusItem("Speech In", vscode.TreeItemCollapsibleState.None, state.settings.audioUnderstandingProvider),
        new StatusItem("Speech Out", vscode.TreeItemCollapsibleState.None, state.settings.ttsProvider),
        new StatusItem("MiniMax Key", vscode.TreeItemCollapsibleState.None, state.keys.minimax ? "saved" : "missing", { command: "englishTraining.configureMiniMaxKey", title: "Configure MiniMax" }),
        new StatusItem("MiMo Key", vscode.TreeItemCollapsibleState.None, state.keys.mimo ? "saved" : "missing", { command: "englishTraining.configureMimoKey", title: "Configure MiMo" }),
        new StatusItem("OpenAI Key", vscode.TreeItemCollapsibleState.None, state.keys.openai ? "saved" : "missing", { command: "englishTraining.configureOpenAIKey", title: "Configure OpenAI" }),
        new StatusItem("Gemini Key", vscode.TreeItemCollapsibleState.None, state.keys.gemini ? "saved" : "missing", { command: "englishTraining.configureGeminiKey", title: "Configure Gemini" }),
        new StatusItem("Kimi Key", vscode.TreeItemCollapsibleState.None, state.keys.kimi ? "saved" : "missing", { command: "englishTraining.configureKimiKey", title: "Configure Kimi" }),
        new StatusItem("DeepSeek Key", vscode.TreeItemCollapsibleState.None, state.keys.deepseek ? "saved" : "missing", { command: "englishTraining.configureDeepSeekKey", title: "Configure DeepSeek" }),
        new StatusItem("Open Task Card", vscode.TreeItemCollapsibleState.None, "markdown", { command: "englishTraining.openTaskCard", title: "Open Task Card" }),
      ];
    } catch (error) {
      return [
        new StatusItem("English Training unavailable", vscode.TreeItemCollapsibleState.None, errorMessage(error)),
      ];
    }
  }
}

function compactStatusValue(value: string, maxLength = 48): string {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, 22)}...${value.slice(-23)}`;
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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function existingFilePath(value: string): string {
  if (!value || isHttpUrl(value) || !fs.existsSync(value)) {
    return "";
  }
  try {
    return fs.statSync(value).isFile() ? value : "";
  } catch {
    return "";
  }
}
