import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type { JsonObject, ProviderName } from "./types.js";

export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const MIMO_ANTHROPIC_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const MINIMAX_TTS_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2";

export const secretKeys: Record<ProviderName, string> = {
  openai: "englishTraining.openaiKey",
  gemini: "englishTraining.geminiKey",
  minimax: "englishTraining.minimaxKey",
  mimo: "englishTraining.mimoKey",
  kimi: "englishTraining.kimiKey",
  deepseek: "englishTraining.deepSeekKey",
  azure: "englishTraining.azureSpeechKey",
};

let _output: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel): void {
  _output = channel;
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_output) {
    throw new Error("English Training output channel has not been initialized.");
  }
  return _output;
}

export function appendOutput(line: string): void {
  _output?.appendLine(line);
}

export function showOutput(preserveFocus = true): void {
  _output?.show(preserveFocus);
}

export function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("englishTraining").get<T>(key) as T;
}

export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function readJson(filePath: string): JsonObject | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
  } catch {
    return undefined;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveFfmpegPath(): string {
  const configured = (config<string>("nativeRecorderFfmpegPath") || "ffmpeg").trim() || "ffmpeg";
  if (configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return configured;
}

export async function getRequiredKey(
  context: vscode.ExtensionContext,
  provider: ProviderName,
): Promise<string> {
  const key = await context.secrets.get(secretKeys[provider]);
  if (!key) {
    throw new Error(`Missing ${providerLabel(provider)} API key. Run the configure command first.`);
  }
  return key;
}

export function providerLabel(provider: ProviderName): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  if (provider === "minimax") return "MiniMax";
  if (provider === "mimo") return "MiMo";
  if (provider === "kimi") return "Kimi";
  if (provider === "azure") return "Azure Speech";
  return "DeepSeek";
}

export function isProviderName(value: unknown): value is ProviderName {
  return (
    value === "openai" ||
    value === "gemini" ||
    value === "minimax" ||
    value === "mimo" ||
    value === "kimi" ||
    value === "deepseek" ||
    value === "azure"
  );
}

export function isCoachProvider(value: unknown): value is ProviderName {
  return (
    value === "minimax" ||
    value === "mimo" ||
    value === "gemini" ||
    value === "kimi" ||
    value === "deepseek" ||
    value === "openai"
  );
}

export function isAudioUnderstandingProvider(value: unknown): value is ProviderName {
  return value === "azure";
}

export function isTtsProvider(value: unknown): value is ProviderName {
  return value === "minimax" || value === "gemini" || value === "openai";
}

export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

export function parseLooseJson(text: string): JsonObject {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as JsonObject;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as JsonObject;
    }
    throw new Error(`Could not parse coaching JSON: ${cleaned.slice(0, 600)}`);
  }
}

export function parseFirstJson(stdout: string): JsonObject | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(trimmed) as JsonObject;
    } catch {
      continue;
    }
  }
  try {
    return JSON.parse(stdout) as JsonObject;
  } catch {
    return undefined;
  }
}

export function extractOpenAIText(parsed: JsonObject): string {
  const direct = stringValue(parsed.output_text);
  if (direct) return direct;
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as JsonObject | undefined;
    const message = first?.message as JsonObject | undefined;
    const content = message?.content;
    const textContent = typeof content === "string" ? content : "";
    if (textContent) return textContent;
    if (Array.isArray(content)) {
      const parts = content.map((part) => stringValue((part as JsonObject).text)).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
  }
  const output = parsed.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as JsonObject).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const partObj = part as JsonObject;
          const text = stringValue(partObj.text) || stringValue(partObj.output_text);
          if (text) parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return JSON.stringify(parsed);
}

export function extractGeminiText(parsed: JsonObject): string {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) return JSON.stringify(parsed);
  const first = candidates[0] as JsonObject | undefined;
  const content = first?.content as JsonObject | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return JSON.stringify(parsed);
  return parts.map((part) => stringValue((part as JsonObject).text)).filter(Boolean).join("\n");
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
