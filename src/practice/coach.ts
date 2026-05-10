import * as vscode from "vscode";

import {
  appendOutput,
  chatCompletionsUrl,
  config,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  extractGeminiText,
  extractOpenAIText,
  getRequiredKey,
  MIMO_ANTHROPIC_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL,
  parseLooseJson,
  stringValue,
} from "../core.js";
import type { CoachPriorTurn, JsonObject, TrainingState } from "../types.js";

export async function coachTranscript(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const provider = config<string>("coachProvider") || "minimax";
  if (provider === "gemini") {
    return coachWithGemini(context, state, transcript, priorTurn);
  }
  if (provider === "kimi") {
    return coachWithKimi(context, state, transcript, priorTurn);
  }
  if (provider === "deepseek") {
    return coachWithDeepSeek(context, state, transcript, priorTurn);
  }
  if (provider === "mimo") {
    return coachWithMimo(context, state, transcript, priorTurn);
  }
  if (provider === "openai") {
    return coachWithOpenAI(context, state, transcript, priorTurn);
  }
  return coachWithMiniMax(context, state, transcript, priorTurn);
}

export function coachingSystemPrompt(): string {
  return [
    "You are an English speaking coach for a Chinese legal academic.",
    "Return strict JSON only.",
    "Focus on natural spoken academic English, not generic encouragement.",
    "If a learner profile is provided, use it to adapt examples, terminology, tone, and follow-up questions.",
    "If prior_turn is present, the user_transcript is the learner replying to that follow_up_question; build on it instead of resetting the conversation.",
    "Give one native speaker version, 1-2 concrete problems, one quick fix, one shadowing instruction, and one specific follow-up question.",
    "Explanations may be in Chinese, but native_version and follow_up_question must be natural English.",
  ].join(" ");
}

export function coachingUserPrompt(
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): string {
  const training = state.training;
  const frames = Array.isArray(training.frames)
    ? training.frames
        .map((item) =>
          typeof item === "object" && item ? stringValue((item as JsonObject).text) : stringValue(item),
        )
        .filter(Boolean)
    : [];
  const payload: JsonObject = {
    task: {
      package_date: stringValue(state.next.package_date),
      goal: stringValue(training.goal) || stringValue(state.next.goal),
      scenario: stringValue(training.scenario) || stringValue(state.next.scenario),
      frames,
    },
    learner_profile: state.learnerProfile.loaded
      ? {
          source: state.learnerProfile.source,
          summary: state.learnerProfile.summary,
          content: state.learnerProfile.content,
        }
      : null,
    user_transcript: transcript,
    output_shape: {
      native_version: "one natural spoken English version of what the user meant",
      problems: ["1-2 concrete issues in Chinese, with tiny English examples if useful"],
      error_tags: ["0-3 of [TA], [ART], [COUNT], [REF], [ORG], [LINK], [PRAG], [PROS]"],
      scores: {
        fluency: "integer 1-5",
        accuracy: "integer 1-5",
        naturalness: "integer 1-5",
      },
      quick_fix: "one practical fix in Chinese",
      shadowing_instruction: "short instruction asking user to repeat the native version once",
      follow_up_question: "one specific English follow-up question",
      next_drill: "one short FSI-style drill instruction for the next repetition",
    },
  };
  if (priorTurn) {
    payload.prior_turn = {
      coach_native_version: priorTurn.nativeVersion,
      coach_follow_up_question: priorTurn.followUpQuestion,
      learner_previous_transcript: priorTurn.userTranscript,
    };
  }
  return JSON.stringify(payload, null, 2);
}

async function coachWithOpenAI(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiCoachModel") || "gpt-4o-mini";
  const input = [
    { role: "system", content: coachingSystemPrompt() },
    { role: "user", content: coachingUserPrompt(state, transcript, priorTurn) },
  ];

  const responsesBody = {
    model,
    input,
    text: { format: { type: "json_object" } },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(responsesBody),
  });
  const body = await response.text();
  if (response.ok) {
    return parseLooseJson(extractOpenAIText(JSON.parse(body) as JsonObject));
  }

  appendOutput(`OpenAI Responses API failed, falling back to chat completions: ${body.slice(0, 600)}`);
  const fallback = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: input,
      response_format: { type: "json_object" },
    }),
  });
  const fallbackBody = await fallback.text();
  if (!fallback.ok) {
    throw new Error(`OpenAI coaching failed (${fallback.status}): ${fallbackBody.slice(0, 1200)}`);
  }
  return parseLooseJson(extractOpenAIText(JSON.parse(fallbackBody) as JsonObject));
}

async function coachWithMiniMax(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "minimax");
  return coachWithAnthropic(state, transcript, priorTurn, {
    provider: "MiniMax",
    apiKey,
    baseUrl: config<string>("minimaxAnthropicBaseUrl") || MINIMAX_ANTHROPIC_BASE_URL,
    model: config<string>("minimaxCoachModel") || "MiniMax-M2.7",
  });
}

async function coachWithMimo(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "mimo");
  return coachWithAnthropic(state, transcript, priorTurn, {
    provider: "MiMo",
    apiKey,
    baseUrl: config<string>("mimoAnthropicBaseUrl") || MIMO_ANTHROPIC_BASE_URL,
    model: config<string>("mimoCoachModel") || "mimo-v2.5-pro",
  });
}

async function coachWithKimi(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "kimi");
  return coachWithOpenAICompatibleChat(state, transcript, priorTurn, {
    provider: "Kimi",
    baseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
    model: config<string>("kimiCoachModel") || "kimi-for-coding",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

async function coachWithDeepSeek(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "deepseek");
  return coachWithAnthropic(state, transcript, priorTurn, {
    provider: "DeepSeek",
    apiKey,
    baseUrl: config<string>("deepseekAnthropicBaseUrl") || DEEPSEEK_ANTHROPIC_BASE_URL,
    model: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
  });
}

async function coachWithAnthropic(
  state: TrainingState,
  transcript: string,
  priorTurn: CoachPriorTurn | undefined,
  options: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  },
): Promise<JsonObject> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "X-Api-Key": options.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 2048,
      system: coachingSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: coachingUserPrompt(state, transcript, priorTurn),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.provider} coaching failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const text = extractAnthropicText(parsed);
  return parseLooseJson(stripThinkBlocks(text));
}

async function coachWithOpenAICompatibleChat(
  state: TrainingState,
  transcript: string,
  priorTurn: CoachPriorTurn | undefined,
  options: {
    provider: string;
    baseUrl: string;
    model: string;
    headers: Record<string, string>;
    responseFormat?: JsonObject;
  },
): Promise<JsonObject> {
  const requestBody: JsonObject = {
    model: options.model,
    messages: [
      { role: "system", content: coachingSystemPrompt() },
      { role: "user", content: coachingUserPrompt(state, transcript, priorTurn) },
    ],
    stream: false,
  };
  if (options.provider !== "Kimi") {
    requestBody.temperature = 0.2;
  }
  if (options.responseFormat) {
    requestBody.response_format = options.responseFormat;
  }
  const response = await fetch(chatCompletionsUrl(options.baseUrl), {
    method: "POST",
    headers: {
      ...options.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.provider} coaching failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  return parseLooseJson(stripThinkBlocks(extractOpenAIText(JSON.parse(body) as JsonObject)));
}

async function coachWithGemini(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiCoachModel") || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: coachingSystemPrompt() }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: coachingUserPrompt(state, transcript, priorTurn) }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini coaching failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const text = extractGeminiText(parsed);
  return parseLooseJson(text);
}

function extractAnthropicText(parsed: JsonObject): string {
  const content = parsed.content;
  if (!Array.isArray(content)) {
    return JSON.stringify(parsed);
  }
  const parts: string[] = [];
  for (const block of content) {
    const blockObj = block as JsonObject;
    const type = stringValue(blockObj.type);
    if (type === "text") {
      const text = stringValue(blockObj.text);
      if (text) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n") : JSON.stringify(parsed);
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
