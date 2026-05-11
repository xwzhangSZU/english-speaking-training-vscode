import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  config,
  getRequiredKey,
  MINIMAX_TTS_BASE_URL,
  normalizeTtsSpeed,
  stringValue,
} from "../core.js";
import type { JsonObject } from "../types.js";

export function speechOutputFileName(provider: string): string {
  return `native-version.${speechOutputExtension(provider)}`;
}

export function speechOutputExtension(provider: string): string {
  return provider === "gemini" ? "wav" : "mp3";
}

export function mimeTypeForAudioPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "audio/mpeg";
}

export async function synthesizeWithConfiguredTts(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  provider = config<string>("ttsProvider") || "minimax",
  speedOverride?: number,
): Promise<{ provider: string; filePath: string }> {
  if (provider === "gemini") {
    return { provider, filePath: await synthesizeGemini(context, text, outPath) };
  }
  if (provider === "openai") {
    return { provider, filePath: await synthesizeOpenAI(context, text, outPath, speedOverride) };
  }
  return { provider: "minimax", filePath: await synthesizeMiniMax(context, text, outPath, speedOverride) };
}

function resolveSpeed(speedOverride?: number): number {
  return normalizeTtsSpeed(speedOverride ?? config<unknown>("ttsSpeed"), 0.9);
}

async function synthesizeOpenAI(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  speedOverride?: number,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("openaiTtsModel") || "gpt-4o-mini-tts",
      voice: config<string>("openaiTtsVoice") || "marin",
      input: text,
      response_format: "mp3",
      speed: resolveSpeed(speedOverride),
    }),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`OpenAI TTS failed (${response.status}): ${body.toString("utf8").slice(0, 1200)}`);
  }
  fs.writeFileSync(outPath, body);
  return outPath;
}

async function synthesizeGemini(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiTtsModel") || "gemini-3.1-flash-tts-preview";
  const voiceName = config<string>("geminiTtsVoice") || "Kore";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text }],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const audio = extractGeminiInlineAudio(JSON.parse(body) as JsonObject);
  if (audio.mimeType.includes("wav")) {
    fs.writeFileSync(outPath, audio.data);
  } else {
    writePcm16Wav(outPath, audio.data, 24000, 1);
  }
  return outPath;
}

async function synthesizeMiniMax(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  speedOverride?: number,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "minimax");
  const ttsBaseUrl = config<string>("minimaxTtsBaseUrl") || MINIMAX_TTS_BASE_URL;
  const response = await fetch(ttsBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("minimaxTtsModel") || "speech-2.8-hd",
      text,
      stream: false,
      output_format: "hex",
      language_boost: "auto",
      voice_setting: {
        voice_id: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
        speed: resolveSpeed(speedOverride),
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const baseResp = (parsed.base_resp as JsonObject | undefined) ?? {};
  if (Number(baseResp.status_code ?? 0) !== 0) {
    const statusCode = stringValue(baseResp.status_code);
    const statusMsg = stringValue(baseResp.status_msg);
    if (statusCode === "2049") {
      throw new Error(
        `MiniMax TTS API error 2049: invalid api key for ${ttsBaseUrl}. ` +
          `For the mainland/resource-pack key, use ${MINIMAX_TTS_BASE_URL} and reconfigure the MiniMax key.`,
      );
    }
    throw new Error(`MiniMax TTS API error ${statusCode}: ${statusMsg}`);
  }
  const audioHex = stringValue((parsed.data as JsonObject | undefined)?.audio);
  if (!audioHex) {
    throw new Error("MiniMax TTS returned empty audio data.");
  }
  fs.writeFileSync(outPath, Buffer.from(audioHex, "hex"));
  return outPath;
}

function extractGeminiInlineAudio(parsed: JsonObject): { data: Buffer; mimeType: string } {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error("Gemini TTS returned no candidates.");
  }
  for (const candidate of candidates) {
    const content = (candidate as JsonObject).content as JsonObject | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const partObj = part as JsonObject;
      const inlineData =
        (partObj.inlineData as JsonObject | undefined) ?? (partObj.inline_data as JsonObject | undefined);
      const data = stringValue(inlineData?.data);
      if (data) {
        return {
          data: Buffer.from(data, "base64"),
          mimeType:
            stringValue(inlineData?.mimeType) ||
            stringValue(inlineData?.mime_type) ||
            "audio/L16;rate=24000",
        };
      }
    }
  }
  throw new Error("Gemini TTS returned no inline audio data.");
}

function writePcm16Wav(filePath: string, pcm: Buffer, sampleRate: number, channels: number): void {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}
