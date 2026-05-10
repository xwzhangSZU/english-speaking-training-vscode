import { Blob } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { config, getRequiredKey, resolveFfmpegPath, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";

const FAST_TRANSCRIPTION_API_VERSION = "2025-10-15";

export async function transcribeAudio(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  return transcribeWithAzure(context, audioPath, mimeType, sessionDir);
}

export async function prepareInlineAudio(
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<{ filePath: string; mimeType: string; base64: string }> {
  const wavPath = path.join(sessionDir, "audio-understanding-input.wav");
  if (!/audio\/(?:wav|x-wav)$/i.test(mimeType) || audioPath !== wavPath) {
    await convertAudioToWav(audioPath, wavPath);
  }
  return {
    filePath: wavPath,
    mimeType: "audio/wav",
    base64: fs.readFileSync(wavPath).toString("base64"),
  };
}

export function convertAudioToWav(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      resolveFfmpegPath(),
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        outPath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 2 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Audio conversion to WAV failed: ${stderr || error.message}`));
          return;
        }
        resolve();
      },
    );
    child.on("error", (error) => reject(error));
  });
}

export function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

async function transcribeWithAzure(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "azure");
  const region = (config<string>("azureSpeechRegion") || "eastus").trim();
  const locale = (config<string>("azureSpeechLocale") || "en-US").trim();
  const uploadPath = await ensureAzureUploadPath(audioPath, mimeType, sessionDir);
  const audioMime = uploadMimeType(uploadPath);
  const audioBuffer = fs.readFileSync(uploadPath);

  const form = new FormData();
  form.append("audio", new Blob([audioBuffer], { type: audioMime }), path.basename(uploadPath));
  form.append(
    "definition",
    JSON.stringify({
      locales: [locale],
      profanityFilterMode: "Masked",
    }),
  );

  const url = `https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${FAST_TRANSCRIPTION_API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      Accept: "application/json",
    },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Azure fast transcription failed (${response.status}): ${body.slice(0, 1500)}`,
    );
  }
  const text = extractAzureTranscript(JSON.parse(body) as JsonObject).trim();
  if (!text) {
    throw new Error("Azure fast transcription returned empty text.");
  }
  return text;
}

async function ensureAzureUploadPath(
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  if (isAzureSupportedAudio(audioPath, mimeType)) {
    return audioPath;
  }
  const wavPath = path.join(sessionDir, "azure-fast-transcribe.wav");
  await convertAudioToWav(audioPath, wavPath);
  return wavPath;
}

function isAzureSupportedAudio(audioPath: string, mimeType: string): boolean {
  const lower = (mimeType || "").toLowerCase();
  if (
    lower.includes("wav") ||
    lower.includes("mpeg") ||
    lower.includes("mp3") ||
    lower.includes("ogg") ||
    lower.includes("flac") ||
    lower.includes("opus")
  ) {
    return true;
  }
  const ext = path.extname(audioPath).toLowerCase();
  return [".wav", ".mp3", ".ogg", ".opus", ".flac"].includes(ext);
}

function uploadMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function extractAzureTranscript(parsed: JsonObject): string {
  const combined = parsed.combinedPhrases;
  if (Array.isArray(combined) && combined.length) {
    const parts = combined
      .map((entry) => stringValue((entry as JsonObject).text))
      .filter(Boolean);
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }
  const phrases = parsed.phrases;
  if (Array.isArray(phrases) && phrases.length) {
    const parts = phrases
      .map((entry) => stringValue((entry as JsonObject).text))
      .filter(Boolean);
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }
  return stringValue(parsed.displayText);
}
