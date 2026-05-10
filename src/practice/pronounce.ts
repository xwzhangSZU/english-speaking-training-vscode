import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { config, getRequiredKey, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { convertAudioToWav } from "./transcribe.js";

export type PronunciationGradingSystem = "FivePoint" | "HundredMark";
export type PronunciationGranularity = "Phoneme" | "Word" | "FullText";

export interface PronunciationAssessmentOptions {
  gradingSystem?: PronunciationGradingSystem;
  granularity?: PronunciationGranularity;
  enableMiscue?: boolean;
  enableProsody?: boolean;
  locale?: string;
}

export interface PronunciationWordScore {
  word: string;
  accuracyScore: number;
  errorType: string;
}

export interface PronunciationAssessmentResult {
  recognizedText: string;
  accuracyScore: number;
  fluencyScore: number;
  prosodyScore: number;
  completenessScore: number;
  pronScore: number;
  words: PronunciationWordScore[];
  raw: JsonObject;
}

export async function assessPronunciation(
  context: vscode.ExtensionContext,
  audioPath: string,
  referenceText: string,
  sessionDir: string,
  options: PronunciationAssessmentOptions = {},
): Promise<PronunciationAssessmentResult> {
  const apiKey = await getRequiredKey(context, "azure");
  const region = (config<string>("azureSpeechRegion") || "eastus").trim();
  const locale = (options.locale || config<string>("azureSpeechLocale") || "en-US").trim();
  const wavPath = await ensurePcmWavForShortAudio(audioPath, sessionDir);
  const audioBuffer = fs.readFileSync(wavPath);

  const paramsJson = JSON.stringify({
    ReferenceText: referenceText,
    GradingSystem: options.gradingSystem || "HundredMark",
    Granularity: options.granularity || "Word",
    Dimension: "Comprehensive",
    EnableMiscue: options.enableMiscue ? "True" : "False",
    EnableProsodyAssessment: options.enableProsody === false ? "False" : "True",
  });
  const pronAssessmentHeader = Buffer.from(paramsJson, "utf8").toString("base64");

  const url = `https://${encodeURIComponent(region)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      "Pronunciation-Assessment": pronAssessmentHeader,
      Accept: "application/json",
    },
    body: audioBuffer,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Azure pronunciation assessment failed (${response.status}): ${body.slice(0, 1500)}`,
    );
  }
  const parsed = JSON.parse(body) as JsonObject;
  const status = stringValue(parsed.RecognitionStatus);
  if (status && status !== "Success" && status !== "0") {
    throw new Error(`Azure pronunciation assessment status=${status}: ${body.slice(0, 800)}`);
  }
  return normalizePronunciationResult(parsed);
}

async function ensurePcmWavForShortAudio(audioPath: string, sessionDir: string): Promise<string> {
  const ext = path.extname(audioPath).toLowerCase();
  if (ext === ".wav") {
    return audioPath;
  }
  const wavPath = path.join(sessionDir, "pronunciation-input.wav");
  await convertAudioToWav(audioPath, wavPath);
  return wavPath;
}

function normalizePronunciationResult(parsed: JsonObject): PronunciationAssessmentResult {
  const nbest = Array.isArray(parsed.NBest) ? parsed.NBest : [];
  const top = (nbest[0] as JsonObject | undefined) ?? {};
  const nested = (top.PronunciationAssessment as JsonObject | undefined) ?? {};
  const accuracyScore = numberOrZero(top.AccuracyScore ?? nested.AccuracyScore);
  const fluencyScore = numberOrZero(top.FluencyScore ?? nested.FluencyScore);
  const prosodyScore = numberOrZero(top.ProsodyScore ?? nested.ProsodyScore);
  const completenessScore = numberOrZero(top.CompletenessScore ?? nested.CompletenessScore);
  const pronScore = numberOrZero(top.PronScore ?? nested.PronScore);
  const recognizedText =
    stringValue(top.Display) ||
    stringValue(top.Lexical) ||
    stringValue(parsed.DisplayText);
  const wordsRaw = Array.isArray(top.Words) ? top.Words : [];
  const words: PronunciationWordScore[] = wordsRaw.map((entry) => {
    const word = entry as JsonObject;
    const wordPa = (word.PronunciationAssessment as JsonObject | undefined) ?? {};
    return {
      word: stringValue(word.Word),
      accuracyScore: numberOrZero(word.AccuracyScore ?? wordPa.AccuracyScore),
      errorType: stringValue(word.ErrorType ?? wordPa.ErrorType) || "None",
    };
  });
  return {
    recognizedText,
    accuracyScore,
    fluencyScore,
    prosodyScore,
    completenessScore,
    pronScore,
    words,
    raw: parsed,
  };
}

function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
