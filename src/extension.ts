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
  processPracticeFile,
  readRecentSessionLog,
  splitPracticeText,
} from "./practice/pipeline.js";

let statusProvider: StatusProvider;
let practiceProvider: PracticeViewProvider;
let nativeRecording: NativeRecordingSession | undefined;

const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";
const LOCAL_MICROPHONE_PATTERN = /\b(imac|macbook|mac mini|mac studio|studio display|built[- ]?in|internal)\b/i;

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
  register("englishTraining.configureAzureSpeechKey", async () => {
    await configureApiKey(context, "azure");
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
  register("englishTraining.useAzureAudioUnderstanding", async () => {
    await setProviderSetting("audioUnderstandingProvider", "azure");
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
}

export function deactivate(): void {
  if (nativeRecording && !nativeRecording.process.killed) {
    nativeRecording.process.kill("SIGTERM");
  }
}

function pythonPath(): string {
  return config<string>("pythonPath") || "python3";
}

function trainingSettings(): TrainingState["settings"] {
  return {
    localMaterialsRoot: config<string>("localMaterialsRoot") || "",
    coachProvider: config<string>("coachProvider") || "minimax",
    audioUnderstandingProvider: config<string>("audioUnderstandingProvider") || "azure",
    ttsProvider: config<string>("ttsProvider") || "minimax",
    openaiTranscriptionModel: config<string>("openaiTranscriptionModel") || "gpt-4o-transcribe",
    openaiCoachModel: config<string>("openaiCoachModel") || "gpt-4o-mini",
    geminiCoachModel: config<string>("geminiCoachModel") || "gemini-2.5-flash",
    geminiTtsModel: config<string>("geminiTtsModel") || "gemini-2.5-flash-preview-tts",
    geminiTtsVoice: config<string>("geminiTtsVoice") || "Kore",
    geminiAudioUnderstandingModel: config<string>("geminiAudioUnderstandingModel") || "gemini-2.5-flash",
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
    ttsSpeed: Number(config<number>("ttsSpeed") ?? 0.9),
    recorderBackend: config<string>("recorderBackend") || "macLocal",
    preferredMicrophoneName: config<string>("preferredMicrophoneName") || "",
    blockedMicrophoneNamePattern: config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN,
  };
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
  return fs.existsSync(path.join(root, "prebuilt")) && (
    fs.existsSync(path.join(root, "progress")) ||
    fs.existsSync(path.join(root, "scripts", "english_training_progress.py")) ||
    fs.existsSync(path.join(root, "two-month-english-speaking-training-project.md"))
  );
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
  const timezone = config<string>("timezone") || "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
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
  return {
    package_dir: dir,
    task_card: path.join(dir, "telegram-task-card.md"),
    daily_card: path.join(dir, "daily-card.png"),
    prosody_detail: path.join(dir, "prosody-detail.png"),
    json: path.join(dir, "english-training.json"),
    followup_drill_json: path.join(dir, "followup-drill.json"),
    followup_drill_md: path.join(dir, "followup-drill.md"),
    manifest: path.join(dir, "manifest.json"),
  };
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
    azure: Boolean(await context.secrets.get(secretKeys.azure)),
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
  if (provider === "azure") {
    const settings = vscode.workspace.getConfiguration("englishTraining");
    const currentRegion = (settings.get<string>("azureSpeechRegion") || "").trim() || "eastus";
    const region = await vscode.window.showInputBox({
      title: "Azure Speech Region",
      prompt: "Enter your Azure Speech resource region (eastus, westus, southeastasia, ...).",
      value: currentRegion,
      ignoreFocusOut: true,
    });
    if (region && region.trim() && region.trim() !== currentRegion) {
      await settings.update("azureSpeechRegion", region.trim(), vscode.ConfigurationTarget.Global);
    }
  }
  vscode.window.showInformationMessage(`${label} API key saved.`);
  await refreshAll();
}

async function pickAndConfigureProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const providers: ProviderName[] = ["azure", "minimax", "mimo", "openai", "gemini", "kimi", "deepseek"];
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

function providerSetupHint(provider: ProviderName): string {
  switch (provider) {
    case "azure": return "Azure Speech · STT + Pronunciation Assessment (required for speech input)";
    case "minimax": return "MiniMax · default coach (Token Plan, Anthropic-compatible) + TTS";
    case "mimo": return "Xiaomi MiMo · alternate coach (Token Plan, Anthropic-compatible)";
    case "openai": return "OpenAI · GPT coach + TTS";
    case "gemini": return "Gemini · coach + TTS";
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

async function setProviderSetting(setting: "coachProvider" | "audioUnderstandingProvider" | "ttsProvider", value: string): Promise<void> {
  await vscode.workspace.getConfiguration("englishTraining").update(setting, value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider set to ${value}.`);
  await refreshAll();
}

async function setTtsSpeedConfig(speed: number): Promise<void> {
  if (!Number.isFinite(speed) || speed <= 0) {
    return;
  }
  const clamped = Math.max(0.5, Math.min(1.5, Number(speed.toFixed(2))));
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

function providerSettingLabel(setting: "coachProvider" | "audioUnderstandingProvider" | "ttsProvider"): string {
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
          await pickAndConfigureProviderKey(this.context);
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
        await this.startNativeRecording();
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
    const result = await processPracticeAudio(this.context, message, this.stageReporter(), priorTurn);
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
      },
    });
    await refreshAll();
  }

  private async startNativeRecording(): Promise<void> {
    if (!this.view) {
      return;
    }
    const session = await startNativeFfmpegRecording(this.context);
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
    const result = await processPracticeFile(
      this.context,
      state,
      session.filePath,
      "audio/wav",
      session.sessionDir,
      session.packageDate,
      this.stageReporter(),
      priorTurn,
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
      },
    });
    await refreshAll();
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https: blob: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --soft: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-editor-foreground) 12%);
      --accent: var(--vscode-button-background);
    }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    h2, h3 { margin: 0; font-weight: 650; }
    h2 { font-size: 17px; line-height: 1.3; }
    h3 { font-size: 13px; margin-bottom: 8px; }
    p { line-height: 1.45; margin: 8px 0; }
    button {
      min-height: 30px;
      border: 0;
      border-radius: 5px;
      padding: 0 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: .55; cursor: default; }
    button.active {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    button.ghost {
      background: transparent;
      color: var(--muted);
      min-height: 22px;
      padding: 0 6px;
      font-size: 13px;
    }
    button.ghost:hover { color: var(--vscode-editor-foreground); }
    .stack { display: grid; gap: 12px; }
    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 11px;
      background: var(--vscode-editor-background);
    }
    .record-panel {
      position: sticky;
      top: 0;
      z-index: 4;
      padding: 12px 11px;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 1px 0 var(--border);
    }
    .record-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: nowrap;
    }
    .record-cta {
      width: 52px;
      height: 52px;
      min-height: 52px;
      border-radius: 50%;
      padding: 0;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-errorForeground, #e51400);
      color: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.25);
      transition: background-color .12s ease, box-shadow .12s ease;
    }
    .record-cta:hover { filter: brightness(1.08); }
    .record-cta:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .record-cta-icon {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: width .12s ease, height .12s ease, border-radius .12s ease;
    }
    .record-cta.recording {
      animation: cta-pulse 1.6s ease-in-out infinite;
    }
    .record-cta.recording .record-cta-icon {
      width: 14px;
      height: 14px;
      border-radius: 3px;
    }
    .record-cta.busy {
      opacity: .6;
      cursor: progress;
      animation: none;
    }
    @keyframes cta-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-errorForeground, #e51400) 55%, transparent); }
      50% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--vscode-errorForeground, #e51400) 0%, transparent); }
    }
    .record-meta {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .record-status {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .record-status.busy { color: var(--vscode-charts-blue, var(--accent)); }
    .record-status.error { color: var(--vscode-errorForeground); }
    .record-meter {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    #timer { min-width: 34px; }
    #vu {
      flex: 0 1 100px;
      height: 14px;
      background: var(--soft);
      border-radius: 3px;
    }
    .speed-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      font-size: 11px;
    }
    .speed-label {
      color: var(--muted);
      letter-spacing: .04em;
      text-transform: uppercase;
      font-size: 10px;
      flex-shrink: 0;
    }
    .speed-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1 1 auto;
    }
    .speed-chip {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--soft);
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: background-color .12s ease, border-color .12s ease, color .12s ease;
    }
    .speed-chip:hover { color: var(--vscode-editor-foreground); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .speed-chip[aria-pressed="true"] {
      background: color-mix(in srgb, var(--accent) 18%, var(--soft));
      border-color: color-mix(in srgb, var(--accent) 70%, transparent);
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    button.slow-read-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      background: var(--soft);
      color: var(--vscode-editor-foreground);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      min-height: 22px;
      line-height: 1.2;
    }
    button.slow-read-btn:hover { background: color-mix(in srgb, var(--accent) 14%, var(--soft)); }
    button.slow-read-btn[disabled] { opacity: .55; cursor: progress; }
    .ab-label button.slow-read-btn { margin-left: 6px; vertical-align: middle; }
    .stages {
      list-style: none;
      padding: 0;
      margin: 12px 0 0 0;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .stages li {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10.5px;
      color: var(--muted);
      letter-spacing: .02em;
    }
    .stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--border);
      flex-shrink: 0;
    }
    .stages li.active { color: var(--vscode-editor-foreground); }
    .stages li.active .stage-dot {
      background: var(--accent);
      animation: stage-blink 1s ease-in-out infinite;
    }
    .stages li.done { color: var(--vscode-editor-foreground); }
    .stages li.done .stage-dot {
      background: var(--vscode-testing-iconPassed, var(--accent));
    }
    .stage-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @keyframes stage-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: .35; }
    }
    .progress-panel { padding: 10px 11px; }
    .progress-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
      font-size: 11px;
    }
    .progress-meta .progress-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--soft);
      color: var(--muted);
      letter-spacing: .02em;
    }
    .progress-meta .progress-chip.primary {
      border-color: color-mix(in srgb, var(--accent) 60%, transparent);
      color: var(--vscode-editor-foreground);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .progress-meta .progress-chip.streak {
      color: var(--vscode-editor-foreground);
    }
    .heatmap {
      display: grid;
      grid-template-columns: repeat(30, 1fr);
      gap: 2px;
    }
    .heatmap-cell {
      aspect-ratio: 1 / 1;
      border-radius: 2px;
      background: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent);
      border: 1px solid transparent;
    }
    .heatmap-cell.completed {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 70%, transparent);
    }
    .heatmap-cell.missed {
      background: color-mix(in srgb, var(--vscode-errorForeground, #e51400) 38%, transparent);
    }
    .heatmap-cell.current {
      background: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
      position: relative;
      z-index: 1;
    }
    .heatmap-legend {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      font-size: 10px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .heatmap-legend span { display: inline-flex; align-items: center; gap: 4px; }
    .heatmap-legend i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }
    .heatmap-legend .lg-completed { background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 70%, transparent); }
    .heatmap-legend .lg-current { background: var(--accent); }
    .heatmap-legend .lg-missed { background: color-mix(in srgb, var(--vscode-errorForeground, #e51400) 38%, transparent); }
    .heatmap-legend .lg-pending { background: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent); }
    @media (max-width: 320px) {
      .heatmap { grid-template-columns: repeat(20, 1fr); }
    }
    .onboarding-panel {
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      background: color-mix(in srgb, var(--accent) 6%, var(--vscode-editor-background));
    }
    .onboarding-title {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 600;
    }
    .onboarding-sub {
      margin: 0 0 10px;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }
    .onboarding-steps {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .onboarding-step {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      font-size: 11px;
    }
    .onboarding-step.done {
      opacity: .65;
    }
    .onboarding-step .step-mark {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid var(--border);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: var(--muted);
    }
    .onboarding-step.done .step-mark {
      background: var(--vscode-testing-iconPassed, var(--accent));
      border-color: transparent;
      color: #fff;
    }
    .onboarding-step.active .step-mark {
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 700;
    }
    .onboarding-step .step-body strong {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    .onboarding-step .step-body span {
      color: var(--muted);
    }
    .onboarding-step button {
      min-height: 28px;
      padding: 4px 10px;
      font-size: 11px;
    }
    @media (max-width: 320px) {
      .onboarding-step {
        grid-template-columns: 18px 1fr;
      }
      .onboarding-step button {
        grid-column: 1 / -1;
        justify-self: stretch;
      }
    }
    .turn-breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      font-size: 11px;
      color: var(--muted);
    }
    .turn-chip {
      padding: 2px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--soft);
      letter-spacing: .02em;
      font-variant-numeric: tabular-nums;
      transition: border-color .12s ease, color .12s ease, background-color .12s ease;
    }
    .turn-chip.done {
      color: var(--vscode-editor-foreground);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 50%, var(--border));
      cursor: pointer;
    }
    .turn-chip.done:hover {
      border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    }
    .turn-chip.current {
      background: color-mix(in srgb, var(--accent) 18%, var(--soft));
      border-color: color-mix(in srgb, var(--accent) 70%, transparent);
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    .turn-chip-tag {
      display: inline-block;
      margin-left: 5px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--accent) 24%, transparent);
      color: var(--vscode-editor-foreground);
      font-size: 9px;
      letter-spacing: .06em;
      text-transform: uppercase;
      font-weight: 600;
    }
    .turn-arrow { color: var(--border); font-size: 10px; padding: 0 1px; }
    .turn-history-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 8px;
    }
    .turn-history-head h3 { margin: 0; }
    .turn-history {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 10px;
    }
    .turn-item {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      background: var(--soft);
    }
    .turn-head {
      font-size: 11px;
      color: var(--muted);
      letter-spacing: .04em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .turn-num { font-weight: 600; color: var(--vscode-editor-foreground); }
    .turn-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .turn-col p {
      margin: 4px 0 6px;
      font-size: 13px;
      line-height: 1.45;
    }
    .turn-col audio { width: 100%; }
    .turn-followup {
      margin-top: 8px;
      padding: 6px 8px;
      border-left: 2px solid var(--accent);
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    @media (max-width: 480px) {
      .turn-cols { grid-template-columns: 1fr; }
    }
    .diff-card {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      margin: 8px 0 12px;
    }
    .diff-side {
      padding: 9px 10px;
    }
    .diff-side + .diff-side {
      border-left: 1px solid var(--border);
    }
    .diff-you { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-errorForeground, #e51400) 8%); }
    .diff-native { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-testing-iconPassed, #16a34a) 8%); }
    .diff-label {
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .diff-text {
      margin: 0;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .diff-removed {
      color: var(--vscode-errorForeground, #e51400);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: .85;
    }
    .diff-added {
      color: var(--vscode-testing-iconPassed, #16a34a);
      font-weight: 600;
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #16a34a) 12%, transparent);
      padding: 0 2px;
      border-radius: 2px;
    }
    @media (max-width: 320px) {
      .diff-card { grid-template-columns: 1fr; }
      .diff-side + .diff-side { border-left: 0; border-top: 1px solid var(--border); }
    }
    .ab-audio {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .ab-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ab-side audio { width: 100%; margin: 0; }
    .ab-label { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    @media (max-width: 320px) {
      .ab-audio { grid-template-columns: 1fr; }
    }
    .quick-fix-card {
      border-left: 3px solid var(--accent);
      background: var(--soft);
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 12px;
    }
    .quick-fix-card p { margin: 4px 0 0; line-height: 1.5; }
    .follow-up-card {
      border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, var(--accent)) 45%, var(--border));
      border-left: 3px solid var(--vscode-charts-blue, var(--accent));
      background: color-mix(in srgb, var(--vscode-charts-blue, var(--accent)) 10%, var(--vscode-editor-background));
      border-radius: 4px 6px 6px 4px;
      padding: 12px 14px;
      margin: 14px 0;
      box-shadow: 0 1px 2px rgba(0,0,0,.06);
    }
    .follow-up-label {
      font-size: 10px;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--vscode-charts-blue, var(--accent));
      font-weight: 700;
    }
    .follow-up-text {
      margin: 6px 0 8px;
      font-size: 15px;
      font-weight: 500;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
    }
    .follow-up-card audio { width: 100%; margin-top: 4px; }
    .follow-up-card .loop-actions { margin-top: 10px; }
    .follow-up-card .loop-actions button[data-loop-action="reply"] {
      background: var(--vscode-charts-blue, var(--accent));
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    .follow-up-card .loop-actions button[data-loop-action="reply"]:hover { filter: brightness(1.08); }
    .loop-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .loop-actions button { min-height: 32px; }
    .loop-actions button.slow-read-btn { min-height: 22px; padding: 3px 9px; font-size: 11px; }
    .result-details {
      margin: 10px 0;
      border-top: 1px dashed var(--border);
      padding-top: 8px;
    }
    .result-details summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .04em;
      text-transform: uppercase;
      margin-bottom: 6px;
      list-style: none;
    }
    .result-details summary::before { content: "▸ "; }
    .result-details[open] summary::before { content: "▾ "; }
    .muted { color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--soft);
      font-size: 11px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    #minimaxVoicePicker { row-gap: 6px; }
    .voice-group-label {
      flex-basis: 100%;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: .06em;
      text-transform: uppercase;
      margin: 4px 0 -2px;
    }
    button.voice-toggle {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--muted);
      font-size: 11px;
      min-height: 26px;
      padding: 2px 10px;
      border-radius: 999px;
    }
    button.voice-toggle:hover {
      color: var(--vscode-editor-foreground);
      border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
      border-style: solid;
    }
    .voice-toggle-count {
      display: inline-block;
      margin-left: 4px;
      padding: 0 6px;
      border-radius: 999px;
      background: var(--soft);
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    button[data-voice-id] .voice-tag {
      display: inline-block;
      margin-left: 5px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--vscode-editor-foreground);
      font-size: 9px;
      letter-spacing: .04em;
      text-transform: uppercase;
      vertical-align: 1px;
    }
    .field { margin-top: 10px; }
    .label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .recording {
      outline: 2px solid var(--vscode-errorForeground);
      outline-offset: 2px;
    }
    audio { width: 100%; margin-top: 8px; }
    ol, ul { padding-left: 18px; }
    li { margin: 5px 0; line-height: 1.4; }
    .kv-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .kv-row {
      display: grid;
      gap: 3px;
    }
    .kv-row code {
      display: block;
      padding: 5px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--soft);
      line-height: 1.35;
    }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="stack">
    <section class="panel record-panel">
      <div class="record-row">
        <button id="record" class="record-cta" aria-label="Start recording" title="Start recording">
          <span class="record-cta-icon"></span>
        </button>
        <div class="record-meta">
          <div class="record-status" id="status">Ready to record</div>
          <div class="record-meter">
            <span id="timer">00:00</span>
            <canvas id="vu" width="100" height="14"></canvas>
            <button class="ghost" id="refresh" title="Refresh state" aria-label="Refresh state">↻</button>
          </div>
        </div>
      </div>
      <div class="speed-row" id="speedRow" role="group" aria-label="Playback speed">
        <span class="speed-label">Speed</span>
        <div class="speed-chips" id="speedChips"></div>
      </div>
      <ol class="stages" id="stages" hidden>
        <li data-stage="transcribe"><span class="stage-dot"></span><span class="stage-name">Transcribe</span></li>
        <li data-stage="coach"><span class="stage-dot"></span><span class="stage-name">Coach</span></li>
        <li data-stage="tts"><span class="stage-dot"></span><span class="stage-name">Speak</span></li>
        <li data-stage="save"><span class="stage-dot"></span><span class="stage-name">Save</span></li>
      </ol>
      <audio id="localAudio" controls hidden></audio>
    </section>
    <section class="panel onboarding-panel" id="onboarding" hidden></section>
    <section class="panel progress-panel" id="progress" hidden></section>
    <section class="panel" id="task"></section>
    <section class="panel" id="diagnostics"></section>
    <section class="panel" id="learnerProfile"></section>
    <section class="panel" id="drill"></section>
    <section class="panel" id="turnHistory" hidden></section>
    <section class="panel" id="result" hidden></section>
    <section class="panel" id="sessionLog"></section>
    <section class="panel">
      <h3>Source</h3>
      <div id="source" class="chips"></div>
      <div class="row">
        <button class="secondary" id="configureMaterials">Local Folder</button>
      </div>
    </section>
    <section class="panel">
      <h3>Providers</h3>
      <div class="field">
        <span class="label">Coach</span>
        <div class="row">
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="minimax">MiniMax M2.7</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="mimo">MiMo v2.5</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="openai">OpenAI</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="gemini">Gemini</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="kimi">Kimi</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="deepseek">DeepSeek</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Speech in</span>
        <div class="row">
          <button class="secondary" data-provider-setting="audioUnderstandingProvider" data-provider-value="azure">Azure</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Speech out</span>
        <div class="row">
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="minimax">MiniMax</button>
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="openai">OpenAI</button>
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="gemini">Gemini</button>
        </div>
      </div>
      <div class="field" id="minimaxVoiceField" hidden>
        <span class="label">MiniMax voice</span>
        <div class="row" id="minimaxVoicePicker"></div>
      </div>
    </section>
    <section class="panel">
      <h3>Keys</h3>
      <div id="keys" class="chips"></div>
      <div class="row">
        <button class="secondary" data-key="minimax">MiniMax</button>
        <button class="secondary" data-key="mimo">MiMo</button>
        <button class="secondary" data-key="azure">Azure</button>
        <button class="secondary" data-key="openai">OpenAI</button>
        <button class="secondary" data-key="gemini">Gemini</button>
        <button class="secondary" data-key="kimi">Kimi</button>
        <button class="secondary" data-key="deepseek">DeepSeek</button>
      </div>
    </section>
    <section class="panel">
      <h3>Local</h3>
      <div class="row">
        <button class="secondary" id="completeLocal">Complete</button>
        <button class="secondary" id="openTask">Task Card</button>
        <button class="secondary" id="openFolder">Sessions</button>
      </div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let mediaRecorder = null;
    let stream = null;
    let chunks = [];
    let recorderMode = null;
    let state = null;
    let audioCtx = null;
    let analyser = null;
    let analyserSource = null;
    let vuBuffer = null;
    let vuRaf = null;
    let timerHandle = null;
    let recordingStartedAt = 0;
    const STAGES = ["transcribe", "coach", "tts", "save"];
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    function isRecording() {
      return recorderMode === "native" || (mediaRecorder && mediaRecorder.state === "recording");
    }

    function startVuMeter(mediaStream) {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          audioCtx = new Ctx();
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        analyserSource = audioCtx.createMediaStreamSource(mediaStream);
        analyserSource.connect(analyser);
        vuBuffer = new Uint8Array(analyser.frequencyBinCount);
        drawVu();
      } catch (error) {
        // Silent: VU is best-effort.
      }
    }

    function drawVu() {
      const canvas = $("vu");
      if (!canvas || !analyser || !vuBuffer) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteFrequencyData(vuBuffer);
      ctx.clearRect(0, 0, w, h);
      const bars = 18;
      const gap = 1;
      const barWidth = Math.max(1, (w - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i += 1) {
        const idx = Math.min(vuBuffer.length - 1, Math.floor((i / bars) * vuBuffer.length));
        const value = vuBuffer[idx] / 255;
        const barHeight = Math.max(1.5, value * h);
        const alpha = 0.3 + value * 0.6;
        ctx.fillStyle = "rgba(229, 20, 0, " + alpha.toFixed(2) + ")";
        ctx.fillRect(i * (barWidth + gap), h - barHeight, barWidth, barHeight);
      }
      vuRaf = requestAnimationFrame(drawVu);
    }

    function stopVuMeter() {
      if (vuRaf) cancelAnimationFrame(vuRaf);
      vuRaf = null;
      if (analyserSource) {
        try { analyserSource.disconnect(); } catch (_) {}
      }
      if (analyser) {
        try { analyser.disconnect(); } catch (_) {}
      }
      analyserSource = null;
      analyser = null;
      vuBuffer = null;
      const canvas = $("vu");
      if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    function startTimer() {
      recordingStartedAt = Date.now();
      $("timer").textContent = "00:00";
      timerHandle = setInterval(() => {
        const sec = Math.floor((Date.now() - recordingStartedAt) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        $("timer").textContent = m + ":" + s;
      }, 250);
    }

    function stopTimer() {
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = null;
    }

    function resetStages() {
      document.querySelectorAll(".stages li").forEach((li) => li.classList.remove("active", "done"));
    }

    function showStages(visible) {
      $("stages").hidden = !visible;
      if (visible) resetStages();
    }

    function setStage(stage, status) {
      const el = document.querySelector('.stages li[data-stage="' + stage + '"]');
      if (!el) return;
      if (status === "active") {
        el.classList.remove("done");
        el.classList.add("active");
      } else if (status === "done") {
        el.classList.remove("active");
        el.classList.add("done");
      }
    }

    function markAllStagesDone() {
      STAGES.forEach((stage) => setStage(stage, "done"));
    }

    function renderState(nextState) {
      state = nextState;
      const next = state.next || {};
      const training = state.training || {};
      const drill = state.drill || {};
      const settings = state.settings || {};
      const assets = next.assets || {};
      const todayAudioText = training.tts_example_text || training.clean_tts_text || training.audio_text || training.demo_line || "";
      renderOnboarding(state);
      renderProgress(state.progress);
      renderSourceDiagnostics(state.sourceDiagnostics);
      renderLearnerProfile(state.learnerProfile);
      const weekTag = state.progress && state.progress.weekIndex
        ? "Week " + state.progress.weekIndex + " · Day " + state.progress.dayInWeek + "/" + (state.progress.weekTotalDays || 7)
        : "";
      $("task").innerHTML = \`
        <h2>\${esc(next.completion_label || "Current Package")} \${next.package_date ? "· " + esc(next.package_date) : ""}</h2>
        \${weekTag ? '<p class="muted" style="margin: 0 0 8px;">' + esc(weekTag) + '</p>' : ''}
        <div class="chips">
          <span class="chip">\${esc(state.source || "local")} source</span>
          <span class="chip">\${esc(settings.coachProvider || "minimax")} coach</span>
          <span class="chip">\${esc(settings.audioUnderstandingProvider || "azure")} speech in</span>
          <span class="chip">\${esc(settings.ttsProvider || "minimax")} speech out</span>
          <span class="chip">\${esc(next.training_type || "practice")}</span>
        </div>
        <p>\${esc(training.goal || next.goal || "")}</p>
        <p class="muted">\${esc(training.scenario || next.scenario || "")}</p>
        <div class="field"><span class="label">Frames</span>\${frames(training.frames)}</div>
        <div class="field"><span class="label">Example text</span><p class="text">\${esc(todayAudioText)}</p></div>
        <div class="field">
          <span class="label">Example audio</span>
          <div class="row">
            <button class="secondary" data-action="today-tts" \${todayAudioText ? "" : "disabled"}>Generate Example</button>
            <span class="muted" id="todayTtsStatus">Reads example only, with \${esc(settings.ttsProvider || "minimax")}</span>
          </div>
          <audio id="todayAudio" controls hidden></audio>
        </div>
      \`;
      $("drill").innerHTML = \`
        <h3>Drill</h3>
        <div class="chips">
          <span class="chip">\${esc(drill.method || "FSI-style drill")}</span>
          \${(drill.primary_tags || []).map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("")}
          \${drill.required_frames ? '<span class="chip">use ' + esc(drill.required_frames) + ' frames</span>' : ''}
        </div>
        <div class="field"><span class="label">Routine</span>\${simpleList(drill.routine_zh)}</div>
        <div class="field"><span class="label">Rounds</span>\${drillRounds(drill.rounds)}</div>
        <div class="field"><span class="label">Shadowing</span>\${shadowing(drill.shadowing_loop)}</div>
        <div class="field"><span class="label">Repair focus</span>\${simpleList(drill.repair_drills)}</div>
      \`;
      $("sessionLog").innerHTML = \`
        <h3>Session Log</h3>
        \${recentSessions(state.recentSessions || [])}
      \`;
      $("source").innerHTML = \`
        <span class="chip">\${esc(state.source || "local")}</span>
        \${state.sourceLabel ? '<span class="chip">' + esc(shortSourceLabel(state.sourceLabel)) + '</span>' : ''}
      \`;
      $("keys").innerHTML = ["minimax", "mimo", "azure", "openai", "gemini", "kimi", "deepseek"].map((name) => {
        const ok = state.keys && state.keys[name];
        return \`<span class="chip">\${name}: \${ok ? "saved" : "missing"}</span>\`;
      }).join("");
      document.querySelectorAll("[data-provider-setting]").forEach((button) => {
        const setting = button.dataset.providerSetting;
        const value = button.dataset.providerValue;
        const active = settings && settings[setting] === value;
        button.classList.toggle("active", Boolean(active));
      });
      renderMinimaxVoicePicker(settings);
      renderSpeedChips(settings);
    }

    const SPEED_OPTIONS = [0.6, 0.8, 0.9, 1.0, 1.2];

    function renderSpeedChips(settings) {
      const chips = $("speedChips");
      if (!chips) return;
      const current = Number((settings && settings.ttsSpeed) ?? 0.9);
      const hasPresetMatch = SPEED_OPTIONS.some((speed) => Math.abs(speed - current) < 0.01);
      const fragments = SPEED_OPTIONS.map((speed) => {
        const pressed = !hasPresetMatch ? false : Math.abs(speed - current) < 0.01;
        const label = (speed.toFixed(1) + "×").replace(".0", "");
        return '<button type="button" class="speed-chip" data-speed="' + speed + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(label) + '</button>';
      });
      if (!hasPresetMatch && Number.isFinite(current) && current > 0) {
        const labelText = Number.isInteger(current)
          ? String(current)
          : current.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
        const label = labelText + "×";
        fragments.push('<button type="button" class="speed-chip" data-speed="' + current + '" aria-pressed="true" title="Custom speed from settings.json">' + esc(label) + '</button>');
      }
      chips.innerHTML = fragments.join("");
      chips.querySelectorAll("button[data-speed]").forEach((button) => {
        button.addEventListener("click", () => {
          const value = Number(button.dataset.speed);
          if (Number.isFinite(value) && value > 0) {
            vscode.postMessage({ type: "setTtsSpeed", value });
          }
        });
      });
    }

    const MINIMAX_VOICE_OPTIONS = [
      { group: "Female (US)", id: "English_CalmWoman", label: "Calm Woman", favorite: true },
      { group: "Female (US)", id: "English_Upbeat_Woman", label: "Upbeat Woman" },
      { group: "Female (US)", id: "English_AttractiveGirl", label: "Attractive" },
      { group: "Female (US)", id: "English_Kind-heartedGirl", label: "Kind-Hearted" },
      { group: "Female (US)", id: "English_FriendlyNeighbor", label: "Friendly Neighbor" },
      { group: "Female (US)", id: "English_SereneWoman", label: "Serene" },
      { group: "Female (US)", id: "English_radiant_girl", label: "Radiant" },
      { group: "Female (US)", id: "English_nursery_teacher_vv2", label: "Nursery Teacher" },
      { group: "Female (UK)", id: "English_Graceful_Lady", label: "Graceful Lady", favorite: true },
      { group: "Female (UK)", id: "English_compelling_lady1", label: "Compelling Lady" },
      { group: "Male (US)", id: "English_Trustworth_Man", label: "Trustworthy", favorite: true },
      { group: "Male (US)", id: "English_Diligent_Man", label: "Diligent" },
      { group: "Male (US)", id: "English_Gentle-voiced_man", label: "Gentle-voiced" },
      { group: "Male (US)", id: "English_FriendlyPerson", label: "Friendly Guy" },
      { group: "Male (US)", id: "English_GentleTeacher", label: "Gentle Teacher" },
      { group: "Male (US)", id: "English_engaging_instructor_vv2", label: "Engaging Instructor", favorite: true },
      { group: "Male (US)", id: "English_magnetic_voiced_man", label: "Magnetic Voice" },
      { group: "Male (UK)", id: "English_expressive_narrator", label: "Expressive Narrator", favorite: true },
      { group: "Male (UK)", id: "English_Magnetic_Male_2", label: "Magnetic Man" },
      { group: "Male (AU)", id: "English_Aussie_Bloke", label: "Aussie Bloke", favorite: true },
      { group: "Cloned (Turbo)", id: "anne_v001", label: "Anne (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "julianne_v004", label: "Julianne (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "marylouise_v004", label: "Mary Louise (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "audie_v005", label: "Audie (clone)", cloned: true },
    ];

    let voicePickerExpanded = false;

    function voiceChipHtml(opt, current) {
      const active = opt.id === current ? " active" : "";
      const cloned = opt.cloned ? ' data-voice-cloned="1"' : "";
      const tag = opt.cloned ? '<span class="voice-tag" title="Cloned voice — pinned to Turbo">clone</span>' : '';
      return '<button class="secondary' + active + '" data-voice-id="' + esc(opt.id) + '"' + cloned + ' title="' + esc(opt.id) + '">' + esc(opt.label) + tag + '</button>';
    }

    function renderMinimaxVoicePicker(settings) {
      const field = $("minimaxVoiceField");
      const picker = $("minimaxVoicePicker");
      if (!field || !picker) return;
      const ttsProvider = settings && settings.ttsProvider;
      if (ttsProvider !== "minimax") {
        field.hidden = true;
        picker.innerHTML = "";
        return;
      }
      field.hidden = false;
      const current = (settings && settings.minimaxTtsVoiceId) || "";
      const fragments = [];

      if (voicePickerExpanded) {
        const groups = new Map();
        for (const option of MINIMAX_VOICE_OPTIONS) {
          if (!groups.has(option.group)) groups.set(option.group, []);
          groups.get(option.group).push(option);
        }
        for (const [group, options] of groups) {
          fragments.push('<span class="voice-group-label">' + esc(group) + '</span>');
          for (const opt of options) {
            fragments.push(voiceChipHtml(opt, current));
          }
        }
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="collapse" title="Show favorites only">Hide ⌃</button>');
      } else {
        const favorites = MINIMAX_VOICE_OPTIONS.filter((opt) => opt.favorite);
        const currentIsFavorite = favorites.some((opt) => opt.id === current);
        for (const opt of favorites) {
          fragments.push(voiceChipHtml(opt, current));
        }
        if (current && !currentIsFavorite) {
          const activeOpt = MINIMAX_VOICE_OPTIONS.find((opt) => opt.id === current);
          if (activeOpt) {
            fragments.push('<span class="voice-group-label">Active</span>');
            fragments.push(voiceChipHtml(activeOpt, current));
          }
        }
        const hiddenCount = MINIMAX_VOICE_OPTIONS.length - favorites.length;
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="expand" title="Show all voices">All voices ⌄ <span class="voice-toggle-count">' + hiddenCount + '</span></button>');
      }

      picker.innerHTML = fragments.join("");
      picker.querySelectorAll("button[data-voice-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const voiceId = button.dataset.voiceId;
          const cloned = button.dataset.voiceCloned === "1";
          vscode.postMessage({ type: "setMinimaxVoice", voiceId, pinTurbo: cloned });
        });
      });
      picker.querySelectorAll("button[data-voice-toggle]").forEach((button) => {
        button.addEventListener("click", () => {
          voicePickerExpanded = button.dataset.voiceToggle === "expand";
          renderMinimaxVoicePicker((state && state.settings) || settings);
        });
      });
    }

    function renderOnboarding(currentState) {
      const panel = $("onboarding");
      if (!panel) return;
      const keys = (currentState && currentState.keys) || {};
      const providerNames = ["minimax", "mimo", "openai", "gemini", "kimi", "deepseek"];
      const hasAnyProviderKey = providerNames.some((name) => keys[name]);
      const source = currentState && currentState.source;
      const sourceLabel = currentState && currentState.sourceLabel;
      const sourceConfigured = Boolean(sourceLabel) || source === "local";
      const progress = currentState && currentState.progress;
      const hasLessons = Boolean(progress && progress.total && progress.total > 0);
      const allDone = hasAnyProviderKey && sourceConfigured && hasLessons;
      if (allDone) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      const sourceStep = sourceConfigured
        ? { state: "done", title: "Source connected", hint: "Local prebuilt folder", action: "" }
        : { state: "active", title: "Pick local folder", hint: "Choose a folder containing prebuilt/", action: '<button class="primary" data-onboard="source">Choose folder</button>' };
      const lessonStep = hasLessons
        ? { state: "done", title: "Lesson library ready", hint: progress.total + " lesson" + (progress.total === 1 ? "" : "s") + " in prebuilt/", action: "" }
        : { state: "active", title: "Create your first lesson", hint: "Writes a starter prebuilt/<today>/english-training.json", action: '<button class="primary" data-onboard="create-sample">Create sample</button>' };
      const keyStep = hasAnyProviderKey
        ? { state: "done", title: "AI provider ready", hint: "At least one provider key saved", action: "" }
        : { state: "active", title: "Add your first AI key", hint: "MiniMax (recommended), OpenAI, Gemini, Kimi, or DeepSeek", action: '<button class="primary" data-onboard="provider-key">Set up</button>' };
      const steps = [sourceStep, lessonStep, keyStep].filter(Boolean);
      const renderedSteps = steps.map((step, idx) => {
        const mark = step.state === "done" ? "✓" : String(idx + 1);
        return \`
          <li class="onboarding-step \${step.state}">
            <span class="step-mark">\${mark}</span>
            <span class="step-body"><strong>\${esc(step.title)}</strong><span>\${esc(step.hint)}</span></span>
            \${step.action || '<span></span>'}
          </li>
        \`;
      }).join("");
      panel.hidden = false;
      panel.innerHTML = \`
        <p class="onboarding-title">Quick setup</p>
        <p class="onboarding-sub">Two minutes to your first practice loop.</p>
        <ol class="onboarding-steps">\${renderedSteps}</ol>
      \`;
    }

    function renderSourceDiagnostics(diagnostics) {
      const panel = $("diagnostics");
      if (!panel) return;
      const value = diagnostics || {};
      const lessonText = (value.lessonCount || 0) + " lesson" + (value.lessonCount === 1 ? "" : "s")
        + (value.dateRange ? " · " + value.dateRange : "");
      const rows = [
        ["Mode", value.mode || "unknown"],
        ["Materials root", value.root || ""],
        ["Configured source", value.configuredRoot || ""],
        ["Lessons", lessonText],
        ["Current package", value.currentPackageDate || ""],
        ["Current JSON", value.currentJson || ""],
        ["Package folder", value.packageDir || ""],
      ].filter((row) => row[1]);
      panel.innerHTML = \`
        <h3>Source Diagnostics</h3>
        <div class="chips">
          <span class="chip">\${esc(value.mode || "unknown")} source</span>
          <span class="chip">\${esc(lessonText)}</span>
        </div>
        <div class="kv-list">
          \${rows.map(([label, text]) => diagnosticRow(label, text)).join("")}
        </div>
      \`;
    }

    function renderLearnerProfile(profile) {
      const panel = $("learnerProfile");
      if (!panel) return;
      const value = profile || {};
      const loaded = Boolean(value.loaded);
      panel.innerHTML = \`
        <h3>Learner Profile</h3>
        <div class="chips">
          <span class="chip">\${loaded ? "Profile loaded" : "Profile missing"}</span>
          <span class="chip">\${esc(value.format || "missing")}</span>
        </div>
        <div class="kv-list">
          \${diagnosticRow("Source", value.source || "profile/learner-profile.md")}
          \${value.summary ? diagnosticRow(loaded ? "Summary" : "Next step", value.summary) : ""}
        </div>
      \`;
    }

    function diagnosticRow(label, value) {
      return \`
        <div class="kv-row">
          <span class="label">\${esc(label)}</span>
          <code title="\${esc(value)}">\${esc(value)}</code>
        </div>
      \`;
    }

    function renderProgress(progress) {
      const panel = $("progress");
      if (!panel) return;
      if (!progress || !Array.isArray(progress.cells) || progress.cells.length === 0) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const total = progress.total || progress.cells.length;
      const dayLabel = progress.currentIndex
        ? "Day " + progress.currentIndex + " / " + total
        : (progress.completedCount || 0) + " / " + total + " completed";
      const weekLabel = progress.weekIndex
        ? "Week " + progress.weekIndex + " · " + (progress.weekCompletedDays || 0) + "/" + (progress.weekTotalDays || 7)
        : "";
      const streakLabel = progress.streak && progress.streak > 0
        ? "🔥 " + progress.streak + "-day streak"
        : "";
      const cells = progress.cells.map((cell) => {
        const status = cell && cell.status ? cell.status : "pending";
        const date = cell && cell.date ? cell.date : "";
        return '<div class="heatmap-cell ' + esc(status) + '" title="' + esc(date) + ' · ' + esc(status) + '"></div>';
      }).join("");
      panel.innerHTML = \`
        <div class="progress-meta">
          <span class="progress-chip primary">\${esc(dayLabel)}</span>
          \${weekLabel ? '<span class="progress-chip">' + esc(weekLabel) + '</span>' : ''}
          \${streakLabel ? '<span class="progress-chip streak">' + esc(streakLabel) + '</span>' : ''}
        </div>
        <div class="heatmap" role="img" aria-label="\${esc(dayLabel)}">\${cells}</div>
        <div class="heatmap-legend" aria-hidden="true">
          <span><i class="lg-completed"></i>done</span>
          <span><i class="lg-current"></i>today</span>
          <span><i class="lg-missed"></i>missed</span>
          <span><i class="lg-pending"></i>upcoming</span>
        </div>
      \`;
    }

    function frames(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No frames.</p>';
      return '<ol>' + value.map((item) => '<li>' + esc((item && item.text) || item) + '</li>').join("") + '</ol>';
    }

    function simpleList(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No items.</p>';
      return '<ul>' + value.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }

    function drillRounds(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No drill rounds.</p>';
      return value.map((round) => {
        const examples = Array.isArray(round.examples) ? round.examples : [];
        return \`
          <div class="field">
            <strong>\${esc(round.label || round.id || "Round")}</strong>
            \${round.base_frame ? '<p class="text">' + esc(round.base_frame) + '</p>' : ''}
            \${examples.length ? '<ol>' + examples.map((item) => '<li><span class="muted">' + esc(item.cue || item.label || "") + '</span> ' + esc(item.text || item) + '</li>').join("") + '</ol>' : ''}
          </div>
        \`;
      }).join("");
    }

    function shadowing(value) {
      const chunks = value && Array.isArray(value.chunks) ? value.chunks : [];
      if (!chunks.length) return '<p class="muted">No shadowing chunks.</p>';
      return '<p class="muted">' + esc(value.instruction_zh || "Shadow each chunk twice.") + '</p><ol>' + chunks.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ol>';
    }

    function recentSessions(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No VS Code sessions yet.</p>';
      return value.map((item) => \`
        <div class="field">
          <strong>\${esc(item.package_date || item.packageDate || "session")}</strong>
          <span class="muted"> · \${esc(item.created_at || item.createdAt || "")}</span>
          \${Array.isArray(item.error_tags) && item.error_tags.length ? '<div class="chips">' + item.error_tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>' : ''}
          <p class="text">\${esc(item.native_version || item.nativeVersion || item.progress_note || "")}</p>
        </div>
      \`).join("");
    }

    function shortSourceLabel(value) {
      const text = String(value || "");
      return text.length > 46 ? text.slice(0, 21) + "..." + text.slice(-20) : text;
    }

    function setStatus(text, tone) {
      const el = $("status");
      el.textContent = text;
      el.classList.remove("busy", "error");
      if (tone === "busy") el.classList.add("busy");
      if (tone === "error") el.classList.add("error");
    }

    function setRecording(active) {
      const btn = $("record");
      btn.classList.toggle("recording", active);
      btn.setAttribute("aria-label", active ? "Stop recording" : "Start recording");
      btn.setAttribute("title", active ? "Stop recording" : "Start recording");
    }

    function setBusy(active, label) {
      const btn = $("record");
      btn.classList.toggle("busy", active);
      btn.disabled = active;
      if (label) setStatus(label, active ? "busy" : undefined);
    }

    function recorderBackend() {
      return String((state.settings && state.settings.recorderBackend) || "macLocal");
    }

    function blockedMicrophonePattern() {
      const pattern = String((state.settings && state.settings.blockedMicrophoneNamePattern) || "iphone|ipad|continuity|karios");
      try {
        return new RegExp(pattern, "i");
      } catch {
        return /iphone|ipad|continuity|karios/i;
      }
    }

    function isBlockedMicrophone(label) {
      return blockedMicrophonePattern().test(String(label || ""));
    }

    function isLocalMicrophone(label) {
      const text = String(label || "").toLowerCase();
      return ["imac", "macbook", "mac mini", "mac studio", "studio display", "built-in", "built in", "internal"].some((name) => text.includes(name));
    }

    async function localAudioConstraints() {
      const base = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return base;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput" && device.label);
      const preferred = String((state.settings && state.settings.preferredMicrophoneName) || "").toLowerCase().trim();
      const byPreferredName = preferred
        ? inputs.find((device) => !isBlockedMicrophone(device.label) && device.label.toLowerCase().includes(preferred))
        : undefined;
      const byLocalName = inputs.find((device) => !isBlockedMicrophone(device.label) && isLocalMicrophone(device.label));
      const byAllowedName = inputs.find((device) => !isBlockedMicrophone(device.label));
      const chosen = byPreferredName || byLocalName || byAllowedName;
      if (chosen) {
        return { ...base, deviceId: { exact: chosen.deviceId } };
      }
      return base;
    }

    async function startRecording() {
      if (recorderBackend() === "macLocal") {
        startNativeRecording("Using Mac local microphone.");
        return;
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        startNativeRecording("Webview recorder unavailable.");
        return;
      }
      chunks = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: await localAudioConstraints() });
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
        mediaRecorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        mediaRecorder.onstop = async () => {
          const mimeType = mediaRecorder.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: mimeType });
          $("localAudio").src = URL.createObjectURL(blob);
          $("localAudio").hidden = false;
          stopVuMeter();
          stopTimer();
          setRecording(false);
          setBusy(true, "Sending to coach…");
          showStages(true);
          const base64 = await blobToBase64(blob);
          const priorTurn = pendingReplyContext;
          pendingReplyContext = null;
          vscode.postMessage({ type: "practiceAudio", mimeType, base64, priorTurn });
          if (stream) stream.getTracks().forEach((track) => track.stop());
        };
        recorderMode = "webview";
        mediaRecorder.start();
        setRecording(true);
        setStatus("Listening… speak now.");
        startVuMeter(stream);
        startTimer();
      } catch (error) {
        startNativeRecording((error && error.message) || String(error));
      }
    }

    function stopRecording() {
      if (recorderMode === "native") {
        vscode.postMessage({ type: "stopNativeRecording" });
        setRecording(false);
        stopTimer();
        setBusy(true, "Stopping native recorder…");
        recorderMode = null;
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    function toggleRecording() {
      if (isRecording()) {
        stopRecording();
      } else {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    }

    function startNativeRecording(reason) {
      recorderMode = "native";
      setRecording(true);
      setStatus((reason ? reason + " " : "") + "Using Mac local recorder…");
      startTimer();
      vscode.postMessage({ type: "startNativeRecording" });
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function normalizeWord(word) {
      return String(word || "").toLowerCase().replace(/[^a-z0-9']/gi, "");
    }

    function wordDiff(left, right) {
      const a = (String(left || "").match(/\\S+/g)) || [];
      const b = (String(right || "").match(/\\S+/g)) || [];
      const m = a.length;
      const n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i += 1) {
        dp.push(new Array(n + 1).fill(0));
      }
      for (let i = 0; i < m; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (normalizeWord(a[i]) && normalizeWord(a[i]) === normalizeWord(b[j])) {
            dp[i + 1][j + 1] = dp[i][j] + 1;
          } else {
            dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }
      const leftMarks = new Array(m).fill("removed");
      const rightMarks = new Array(n).fill("added");
      let i = m;
      let j = n;
      while (i > 0 && j > 0) {
        if (normalizeWord(a[i - 1]) && normalizeWord(a[i - 1]) === normalizeWord(b[j - 1])) {
          leftMarks[i - 1] = "common";
          rightMarks[j - 1] = "common";
          i -= 1;
          j -= 1;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
          i -= 1;
        } else {
          j -= 1;
        }
      }
      return {
        left: a.map((word, k) => ({ word, mark: leftMarks[k] })),
        right: b.map((word, k) => ({ word, mark: rightMarks[k] })),
      };
    }

    function renderDiffSide(items) {
      if (!items.length) return '<span class="muted">—</span>';
      return items.map(({ word, mark }) => {
        const safe = esc(word);
        if (mark === "removed") return '<span class="diff-removed">' + safe + '</span>';
        if (mark === "added") return '<span class="diff-added">' + safe + '</span>';
        return safe;
      }).join(" ");
    }

    function followUpCardHtml(result, followUpAudioSrc) {
      if (!result || !result.followUpQuestion) return "";
      const audioTag = followUpAudioSrc
        ? '<audio id="followUpAudio" controls preload="auto" src="' + esc(followUpAudioSrc) + '"></audio>'
        : '';
      return '<div class="follow-up-card">' +
        '<span class="follow-up-label">Coach asks</span>' +
        '<p class="follow-up-text">' + esc(result.followUpQuestion) + '</p>' +
        audioTag +
        '<div class="loop-actions">' +
          '<button type="button" class="slow-read-btn" data-slow-read="followUp" title="Re-read at 0.7×">🐢 Slow read</button>' +
          '<button type="button" id="answerFollowUpBtn" data-loop-action="reply">Answer follow-up →</button>' +
        '</div>' +
      '</div>';
    }

    let lastTurn = null;
    let pendingReplyContext = null;
    let turnHistory = [];

    function turnBreadcrumbHtml() {
      const total = turnHistory.length;
      if (total === 0) return "";
      const items = turnHistory.map((turn, idx) => {
        const isCurrent = idx === total - 1;
        const cls = "turn-chip " + (isCurrent ? "current" : "done");
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : "";
        const check = isCurrent ? "" : " ✓";
        return '<span class="' + cls + '" data-turn-index="' + (idx + 1) + '" role="button" tabindex="0">Turn ' + (idx + 1) + check + replyTag + '</span>';
      });
      return '<div class="turn-breadcrumb" aria-label="Conversation turns">' + items.join('<span class="turn-arrow" aria-hidden="true">→</span>') + '</div>';
    }

    function renderTurnHistory() {
      const panel = $("turnHistory");
      if (!panel) return;
      if (turnHistory.length <= 1) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const earlier = turnHistory.slice(0, -1);
      const items = earlier.map((turn) => {
        const audio = turn.userAudioUri ? '<audio controls src="' + esc(turn.userAudioUri) + '"></audio>' : '';
        const nativeAudio = turn.nativeAudioUri ? '<audio controls src="' + esc(turn.nativeAudioUri) + '"></audio>' : '';
        const followUpBlock = turn.followUpQuestion
          ? '<div class="turn-followup"><span class="muted">→ Coach asked:</span> ' + esc(turn.followUpQuestion) + '</div>'
          : '';
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : '';
        return '<li class="turn-item" data-turn-item="' + esc(String(turn.turnIndex)) + '">' +
          '<div class="turn-head"><span class="turn-num">Turn ' + esc(String(turn.turnIndex)) + '</span>' + replyTag + '</div>' +
          '<div class="turn-cols">' +
            '<div class="turn-col"><span class="muted">You said</span><p>' + esc(turn.transcript) + '</p>' + audio + '</div>' +
            '<div class="turn-col"><span class="muted">Native</span><p>' + esc(turn.nativeVersion) + '</p>' + nativeAudio + '</div>' +
          '</div>' +
          followUpBlock +
        '</li>';
      }).join("");
      panel.innerHTML =
        '<div class="turn-history-head">' +
          '<h3>Conversation so far</h3>' +
          '<button class="ghost" id="resetTurns" title="Start a new conversation">Reset</button>' +
        '</div>' +
        '<ol class="turn-history">' + items + '</ol>';
      const reset = $("resetTurns");
      if (reset) {
        reset.addEventListener("click", () => {
          turnHistory = [];
          lastTurn = null;
          pendingReplyContext = null;
          vscode.postMessage({ type: "clearReplyContext" });
          renderTurnHistory();
          $("result").hidden = true;
          setStatus("New conversation. Tap to speak.");
        });
      }
    }

    function renderResult(result) {
      const diff = wordDiff(result.transcript, result.nativeVersion);
      const userAudioSrc = (result && result.localAudioUri) || ($("localAudio").src || "");
      const nativeAudioSrc = (result && result.audioUri) || "";
      const followUpAudioSrc = (result && result.followUpAudioUri) || "";
      const tagsHtml = Array.isArray(result.errorTags) && result.errorTags.length
        ? '<div class="chips">' + result.errorTags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>'
        : '<p class="muted">No tags.</p>';
      const problemsHtml = Array.isArray(result.problems) && result.problems.length
        ? '<ul>' + result.problems.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>'
        : '<p class="muted">No specific problems.</p>';

      $("result").hidden = false;
      $("result").innerHTML = \`
        <h3>Coaching · Turn \${turnHistory.length || 1}</h3>
        \${turnBreadcrumbHtml()}
        <div class="diff-card">
          <div class="diff-side diff-you">
            <div class="diff-label">You said</div>
            <p class="diff-text">\${renderDiffSide(diff.left)}</p>
          </div>
          <div class="diff-side diff-native">
            <div class="diff-label">Native says</div>
            <p class="diff-text">\${renderDiffSide(diff.right)}</p>
          </div>
        </div>
        <div class="ab-audio">
          <div class="ab-side">
            <span class="ab-label muted">Your audio</span>
            \${userAudioSrc ? '<audio controls src="' + esc(userAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
          <div class="ab-side">
            <span class="ab-label muted">Native audio
              \${result.nativeVersion ? '<button type="button" class="slow-read-btn" data-slow-read="native" title="Re-read at 0.7×">🐢 Slow</button>' : ''}
            </span>
            \${nativeAudioSrc ? '<audio id="nativeAudio" controls src="' + esc(nativeAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
        </div>
        \${result.quickFix ? '<div class="quick-fix-card"><span class="label">Quick fix</span><p>' + esc(result.quickFix) + '</p></div>' : ''}
        \${followUpCardHtml(result, followUpAudioSrc)}
        <div class="loop-actions">
          <button class="secondary" data-loop-action="imitate">Imitate native</button>
        </div>
        <details class="result-details">
          <summary>More details</summary>
          <div class="field"><span class="label">Problems</span>\${problemsHtml}</div>
          <div class="field"><span class="label">Tags</span>\${tagsHtml}</div>
          \${result.shadowingInstruction ? '<div class="field"><span class="label">Repeat</span><p class="text">' + esc(result.shadowingInstruction) + '</p></div>' : ''}
          \${result.nextDrill ? '<div class="field"><span class="label">Next drill</span><p class="text">' + esc(result.nextDrill) + '</p></div>' : ''}
          <div class="field"><span class="label">Session folder</span><code>\${esc(result.sessionDir)}</code></div>
        </details>
      \`;
      const followUpAudioEl = $("followUpAudio");
      const answerBtn = $("answerFollowUpBtn");
      if (followUpAudioEl && answerBtn) {
        followUpAudioEl.addEventListener("ended", () => {
          if (typeof answerBtn.focus === "function") {
            answerBtn.focus({ preventScroll: false });
          }
        }, { once: true });
      }
    }

    $("record").addEventListener("click", toggleRecording);
    $("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    function focusTurnChip(trigger) {
      const idx = Number(trigger.dataset.turnIndex);
      if (!Number.isFinite(idx) || idx <= 0) return false;
      const targetItem = document.querySelector('[data-turn-item="' + idx + '"]');
      if (targetItem && typeof targetItem.scrollIntoView === "function") {
        targetItem.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      if (idx === turnHistory.length) {
        const result = $("result");
        if (result && typeof result.scrollIntoView === "function") {
          result.scrollIntoView({ behavior: "smooth", block: "start" });
          return true;
        }
      }
      return false;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const trigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (!trigger) return;
      event.preventDefault();
      focusTurnChip(trigger);
    });
    document.addEventListener("click", (event) => {
      const breadcrumbTrigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (breadcrumbTrigger) {
        if (focusTurnChip(breadcrumbTrigger)) return;
      }
      const slowTrigger = event.target.closest && event.target.closest("[data-slow-read]");
      if (slowTrigger) {
        const target = slowTrigger.dataset.slowRead;
        const text = target === "followUp"
          ? (lastTurn && lastTurn.followUpQuestion) || ""
          : (lastTurn && lastTurn.nativeVersion) || "";
        if (!text.trim()) return;
        slowTrigger.disabled = true;
        slowTrigger.dataset.busy = "1";
        slowTrigger.textContent = "🐢 …";
        vscode.postMessage({ type: "slowRead", text, target, speed: 0.7 });
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-loop-action]");
      if (!trigger) return;
      const action = trigger.dataset.loopAction;
      if (action !== "imitate" && action !== "reply") return;
      if (action === "reply" && lastTurn && lastTurn.followUpQuestion) {
        pendingReplyContext = {
          nativeVersion: lastTurn.nativeVersion || "",
          followUpQuestion: lastTurn.followUpQuestion || "",
          userTranscript: lastTurn.transcript || "",
        };
        vscode.postMessage({ type: "setReplyContext", priorTurn: pendingReplyContext });
      } else {
        pendingReplyContext = null;
        vscode.postMessage({ type: "clearReplyContext" });
      }
      const cta = $("record");
      if (cta && typeof cta.scrollIntoView === "function") {
        cta.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (!isRecording()) {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    });
    document.addEventListener("click", (event) => {
      const actionTrigger = event.target.closest && event.target.closest("[data-action]");
      if (actionTrigger && actionTrigger.dataset.action === "today-tts") {
        const status = $("todayTtsStatus");
        if (status) status.textContent = "Generating example…";
        actionTrigger.disabled = true;
        vscode.postMessage({ type: "todayTts" });
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-onboard]");
      if (!trigger) return;
      const action = trigger.dataset.onboard;
      if (action === "source") {
        vscode.postMessage({ type: "command", command: "configureMaterials" });
      } else if (action === "provider-key") {
        vscode.postMessage({ type: "command", command: "setupProviderKey" });
      } else if (action === "create-sample") {
        vscode.postMessage({ type: "command", command: "createSamplePackage" });
      } else if (action === "materials-guide") {
        vscode.postMessage({ type: "command", command: "openMaterialsGuide" });
      }
    });
    $("completeLocal").addEventListener("click", () => vscode.postMessage({ type: "completeLocal" }));
    $("configureMaterials").addEventListener("click", () => vscode.postMessage({ type: "command", command: "configureMaterials" }));
    $("openTask").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openTask" }));
    $("openFolder").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openSessionFolder" }));
    document.querySelectorAll("[data-key]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({ type: "configureKey", provider: button.dataset.key }));
    });
    document.querySelectorAll("[data-provider-setting]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({
        type: "setProvider",
        setting: button.dataset.providerSetting,
        value: button.dataset.providerValue,
      }));
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") renderState(message.state);
      if (message.type === "busy") setStatus(message.message || "Working…", "busy");
      if (message.type === "nativeRecordingStarted") {
        setStatus("Listening… speak now.");
      }
      if (message.type === "stage") {
        if (message.show) showStages(true);
        if (message.stage) setStage(message.stage, message.status || "active");
      }
      if (message.type === "practiceResult") {
        markAllStagesDone();
        setBusy(false);
        setStatus("Ready ✓");
        recorderMode = null;
        if (message.result && message.result.localAudioUri) {
          $("localAudio").src = message.result.localAudioUri;
          $("localAudio").hidden = false;
        }
        const r = message.result || {};
        lastTurn = {
          nativeVersion: r.nativeVersion || "",
          followUpQuestion: r.followUpQuestion || "",
          transcript: r.transcript || "",
        };
        const localAudioFallback = r.localAudioUri || ($("localAudio").src || "");
        turnHistory.push({
          turnIndex: turnHistory.length + 1,
          transcript: r.transcript || "",
          nativeVersion: r.nativeVersion || "",
          followUpQuestion: r.followUpQuestion || "",
          quickFix: r.quickFix || "",
          userAudioUri: localAudioFallback,
          nativeAudioUri: r.audioUri || "",
          followUpAudioUri: r.followUpAudioUri || "",
          priorTurn: r.priorTurn || null,
          timestamp: Date.now(),
        });
        renderResult(message.result);
        renderTurnHistory();
        const resultPanel = $("result");
        if (resultPanel && typeof resultPanel.scrollIntoView === "function") {
          resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        setTimeout(() => showStages(false), 1500);
      }
      if (message.type === "todayTtsStatus") {
        const status = $("todayTtsStatus");
        if (status) status.textContent = message.message || "Generating…";
      }
      if (message.type === "slowReadStatus") {
        // No-op for now; could surface inline status later.
      }
      if (message.type === "slowReadResult") {
        document.querySelectorAll('[data-slow-read]').forEach((btn) => {
          if (btn.dataset.busy === "1") {
            btn.disabled = false;
            delete btn.dataset.busy;
            btn.textContent = btn.dataset.slowRead === "followUp" ? "🐢 Slow read" : "🐢 Slow";
          }
        });
        if (message.error) {
          setStatus("Slow read failed: " + message.error, "error");
          return;
        }
        if (message.result && message.result.audioDataUri) {
          let player = document.getElementById("slowReadAudio");
          if (!player) {
            player = document.createElement("audio");
            player.id = "slowReadAudio";
            player.controls = true;
            player.style.width = "100%";
            player.style.marginTop = "6px";
            document.body.appendChild(player);
          }
          const followUpCard = document.querySelector(".follow-up-card");
          const nativeSide = document.querySelector('.ab-side audio#nativeAudio');
          const host = message.target === "followUp" && followUpCard
            ? followUpCard
            : (nativeSide ? nativeSide.parentNode : null);
          if (host && player.parentNode !== host) {
            host.appendChild(player);
          }
          player.src = message.result.audioDataUri;
          player.hidden = false;
          player.play().catch(() => {});
        }
      }
      if (message.type === "todayTtsResult") {
        const audio = $("todayAudio");
        const status = $("todayTtsStatus");
        if (audio && message.result && message.result.audioDataUri) {
          audio.src = message.result.audioDataUri;
          audio.hidden = false;
          audio.play().catch(() => {});
        }
        if (status) {
          status.textContent = message.result && message.result.provider
            ? "Example generated with " + message.result.provider
            : "Example generated";
        }
        const button = document.querySelector('[data-action="today-tts"]');
        if (button) button.disabled = false;
      }
      if (message.type === "error") {
        if (recorderMode === "native") {
          recorderMode = null;
          setRecording(false);
        }
        stopVuMeter();
        stopTimer();
        setBusy(false);
        const todayButton = document.querySelector('[data-action="today-tts"]');
        if (todayButton) todayButton.disabled = false;
        showStages(false);
        setStatus(message.message || "Error.", "error");
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
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
): Promise<PracticeResult> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const inputExt = extensionFromMime(message.mimeType);
  const inputPath = path.join(sessionDir, `input.${inputExt}`);
  const audioBuffer = Buffer.from(message.base64, "base64");
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
  );
}

async function startNativeFfmpegRecording(context: vscode.ExtensionContext): Promise<NativeRecordingSession> {
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
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
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
  const provider = config<string>("ttsProvider") || "minimax";
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
  const provider = config<string>("ttsProvider") || "minimax";
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
  if (!taskCard) {
    throw new Error("No task card path is available.");
  }
  await vscode.window.showTextDocument(vscode.Uri.file(taskCard));
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
  vscode.window.showInformationMessage(`Sample lesson written to prebuilt/${targetDate}/english-training.json. Edit it and refresh the sidebar.`);
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

async function openMaterialsGuide(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: MATERIALS_GUIDE_MD,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
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
    notes: [
      "This is a starter sample. Edit scenario, goal, frames, and clean_tts_text for your own lesson.",
      "Add stress_guide, intonation_guide, or word_level_prosody for richer prosody coaching.",
      "Use the Example audio button in the sidebar to generate reference TTS from the example only.",
    ],
  };
}

const MATERIALS_GUIDE_MD = [
  "# English Training: Bring Your Own Materials",
  "",
  "The extension reads daily lesson packages from a `prebuilt/` directory.",
  "Each lesson lives in its own `YYYY-MM-DD` folder.",
  "",
  "## Minimum directory layout",
  "",
  "```",
  "your-training-root/",
  "├── prebuilt/",
  "│   ├── 2026-05-10/",
  "│   │   ├── english-training.json   # required",
  "│   ├── 2026-05-11/",
  "│   │   └── english-training.json",
  "│   └── ...",
  "└── progress/                        # auto-created by the extension",
  "```",
  "",
  "Point the extension at this root either way:",
  "",
  "- **Local**: open the parent folder as your VS Code workspace, OR set",
  "  `englishTraining.localMaterialsRoot` to its absolute path so the sidebar",
  "  works from any workspace.",
  "- In the sidebar, click **Local Folder** to choose or switch the local",
  "  materials root.",
  "",
  "The Practice sidebar's **Source Diagnostics** section shows the exact source",
  "mode, root folder, lesson count, current package date, and current",
  "`english-training.json` path.",
  "",
  "## Learner profile",
  "",
  "Add one optional profile file under the same materials root:",
  "",
  "```",
  "profile/learner-profile.md",
  "# or",
  "profile/learner-profile.json",
  "```",
  "",
  "When present, the sidebar shows **Profile loaded** and the coach receives the",
  "profile with each practice turn. Use it for research focus, speaking goals,",
  "common weaknesses, preferred feedback style, and terminology.",
  "",
  "## Required fields in `english-training.json`",
  "",
  "| Field | Type | Purpose |",
  "|-------|------|---------|",
  "| `date` | string `YYYY-MM-DD` | Must match the folder name. |",
  "| `scenario` | string | One-line context: who you're talking to, what they asked. |",
  "| `goal` | string | What a successful answer sounds like. |",
  "| `chinese_setup` | string | Chinese instruction shown to the learner. |",
  "| `frames` | array of `{label, text}` | Reusable spoken patterns. |",
  "| `clean_tts_text` | string | The native-version sentence used for TTS. |",
  "",
  "Useful optional fields: `training_type`, `primary_tags`, `demo_line`,",
  "`audio_text`, `stress_guide`, `intonation_guide`, `word_level_prosody`.",
  "",
  "## Quick start",
  "",
  "1. Open a workspace containing `prebuilt/`, or click **Local Folder** in the sidebar.",
  "2. Run `English Training: Create Sample Package` to write a starter file at",
  "   `prebuilt/<today>/english-training.json`.",
  "3. Edit that file: change `scenario`, `goal`, `frames`, `clean_tts_text`.",
  "4. Click `Refresh` in the sidebar — your lesson appears as the current task.",
  "5. Press the red record button and start practicing.",
  "",
  "## Multiple lessons / a curriculum",
  "",
  "Add one folder per day. The extension auto-walks `prebuilt/` for every",
  "`YYYY-MM-DD` directory and shows the 120-day heatmap from the dates it finds.",
  "There is no required curriculum length — 7 lessons or 365 lessons both work.",
  "",
  "## Example audio",
  "",
  "The sidebar does not require pre-generated OGG/MP3 files. Click",
  "**Generate Example** under *Example audio* to synthesize the example text on",
  "demand with your configured speech-output provider. It reads",
  "`clean_tts_text`, `audio_text`, or `demo_line` only; scenario, goal, and other",
  "background fields are never included in this reference audio.",
  "",
  "## Where session output goes",
  "",
  "- `<root>/runtime/vscode-sessions/<date>/<timestamp>/`.",
  "",
].join("\n");

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
        new StatusItem("Azure Speech Key", vscode.TreeItemCollapsibleState.None, state.keys.azure ? "saved" : "missing", { command: "englishTraining.configureAzureSpeechKey", title: "Configure Azure Speech" }),
        new StatusItem("Open Task Card", vscode.TreeItemCollapsibleState.None, "markdown", { command: "englishTraining.openTaskCard", title: "Open Task Card" }),
      ];
    } catch (error) {
      return [
        new StatusItem("English Training unavailable", vscode.TreeItemCollapsibleState.None, errorMessage(error)),
      ];
    }
  }
}

function randomNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
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

