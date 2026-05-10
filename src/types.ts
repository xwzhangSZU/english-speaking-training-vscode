import type * as cp from "node:child_process";

export type JsonObject = Record<string, unknown>;
export type ProviderName =
  | "openai"
  | "gemini"
  | "minimax"
  | "mimo"
  | "kimi"
  | "deepseek"
  | "azure";
export type ActiveMaterialsSource = "local";
export type KeyAvailability = Record<ProviderName, boolean>;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProgressCell {
  date: string;
  status: "completed" | "current" | "pending" | "missed";
}

export interface ProgressSnapshot {
  total: number;
  completedCount: number;
  currentIndex: number;
  streak: number;
  weekIndex: number;
  dayInWeek: number;
  weekTotalDays: number;
  weekCompletedDays: number;
  cells: ProgressCell[];
}

export interface SourceDiagnostics {
  mode: ActiveMaterialsSource;
  root: string;
  configuredRoot: string;
  packageDir: string;
  currentJson: string;
  currentPackageDate: string;
  lessonCount: number;
  completedCount: number;
  dateRange: string;
}

export interface LearnerProfile {
  loaded: boolean;
  source: string;
  format: "markdown" | "json" | "missing";
  summary: string;
  content: string;
}

export interface TrainingState {
  root: string;
  source: ActiveMaterialsSource;
  sourceLabel: string;
  today: string;
  next: JsonObject;
  training: JsonObject;
  drill: JsonObject;
  progress?: ProgressSnapshot;
  sourceDiagnostics: SourceDiagnostics;
  learnerProfile: LearnerProfile;
  recentSessions: JsonObject[];
  generatedAt: string;
  keys: KeyAvailability;
  settings: {
    localMaterialsRoot: string;
    coachProvider: string;
    audioUnderstandingProvider: string;
    ttsProvider: string;
    openaiTranscriptionModel: string;
    openaiCoachModel: string;
    geminiCoachModel: string;
    geminiTtsModel: string;
    geminiTtsVoice: string;
    geminiAudioUnderstandingModel: string;
    minimaxAnthropicBaseUrl: string;
    minimaxCoachModel: string;
    mimoAnthropicBaseUrl: string;
    mimoCoachModel: string;
    kimiChatBaseUrl: string;
    kimiCoachModel: string;
    deepseekAnthropicBaseUrl: string;
    deepseekCoachModel: string;
    minimaxTtsModel: string;
    minimaxTtsVoiceId: string;
    ttsSpeed: number;
    recorderBackend: string;
    preferredMicrophoneName: string;
    blockedMicrophoneNamePattern: string;
  };
}

export interface CoachPriorTurn {
  nativeVersion: string;
  followUpQuestion: string;
  userTranscript: string;
}

export interface PracticeResult {
  transcript: string;
  nativeVersion: string;
  problems: string[];
  quickFix: string;
  followUpQuestion: string;
  shadowingInstruction: string;
  errorTags: string[];
  nextDrill: string;
  scores: JsonObject;
  audioFile?: string;
  followUpAudioFile?: string;
  sessionDir: string;
  packageDate: string;
}

export interface WebviewAudioMessage {
  type: "practiceAudio";
  base64: string;
  mimeType: string;
  priorTurn?: CoachPriorTurn;
}

export interface NativeRecordingSession {
  process: cp.ChildProcessWithoutNullStreams;
  filePath: string;
  sessionDir: string;
  packageDate: string;
  startedAt: number;
  stderr: string[];
}

export interface AvfoundationAudioDevice {
  index: string;
  name: string;
}

export type PracticeStage = "transcribe" | "coach" | "tts" | "save";
export type StageStatus = "active" | "done";
export type StageReporter = (stage: PracticeStage, status: StageStatus) => void;
