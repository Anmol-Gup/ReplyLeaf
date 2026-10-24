import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

// One adapter per provider. Each takes the same request and returns raw text
// plus token counts. Parsing and validation happen in generateReply(), once,
// for both providers.

export type ChatTurn = { role: "user" | "assistant"; text: string };

export type AdapterRequest = {
  apiKey: string;
  model: string;
  system: string;
  turns: ChatTurn[];
  jsonSchema: object;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type AdapterResponse = { text: string | null; inputTokens: number; outputTokens: number };
export type Adapter = (req: AdapterRequest) => Promise<AdapterResponse>;

export class AiProviderError extends Error {}

export const geminiAdapter: Adapter = async (req) => {
  const ai = new GoogleGenAI({ apiKey: req.apiKey, httpOptions: { timeout: req.timeoutMs } });
  const res = await ai.models.generateContent({
    model: req.model,
    contents: req.turns.map((t) => ({
      role: t.role === "user" ? "user" : "model",
      parts: [{ text: t.text }],
    })),
    config: {
      systemInstruction: req.system,
      responseMimeType: "application/json",
      responseJsonSchema: req.jsonSchema,
      maxOutputTokens: req.maxOutputTokens,
      temperature: 0.2,
    },
  });

  if (res.promptFeedback?.blockReason) {
    throw new AiProviderError(`Gemini blocked the prompt: ${res.promptFeedback.blockReason}`);
  }
  const usage = res.usageMetadata;
  return {
    text: res.text ?? null,
    inputTokens: usage?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output, so count them.
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
};

export const openaiAdapter: Adapter = async (req) => {
  const client = new OpenAI({ apiKey: req.apiKey, timeout: req.timeoutMs, maxRetries: 1 });
  const res = await client.responses.create({
    model: req.model,
    instructions: req.system,
    input: req.turns.map((t) => ({ role: t.role, content: t.text })),
    text: {
      format: {
        type: "json_schema",
        name: "assistant_reply",
        strict: true,
        schema: req.jsonSchema as Record<string, unknown>,
      },
    },
    max_output_tokens: req.maxOutputTokens,
    store: false, // don't keep customer conversations on OpenAI's side
  });

  // A refusal or truncation leaves output_text empty/partial; generateReply's
  // validation will reject it.
  return {
    text: res.output_text || null,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  };
};

export const ADAPTERS = { gemini: geminiAdapter, openai: openaiAdapter } as const;
export type Provider = keyof typeof ADAPTERS;
