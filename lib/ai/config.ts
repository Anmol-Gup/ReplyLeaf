import { z } from "zod";

// AI settings come from env, separate from the Supabase env so the eval script
// can run with only an API key. These are the PLATFORM's keys. A business on its own key ("byok" mode, see
// lib/ai-keys.ts) never uses them: its key is stored encrypted per client and swapped in for each call.
const schema = z.object({
  GEMINI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Model IDs are env-configurable because providers retire models over time.
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  OPENAI_MODEL: z.string().min(1).default("gpt-6-luna"),
});

export type AiConfig = {
  geminiApiKey?: string;
  openaiApiKey?: string;
  geminiModel: string;
  openaiModel: string;
};

export function aiConfig(source: Record<string, string | undefined> = process.env): AiConfig {
  // Treat empty strings (e.g. "GEMINI_API_KEY=" in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const e = schema.parse(cleaned);
  return {
    geminiApiKey: e.GEMINI_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    geminiModel: e.GEMINI_MODEL,
    openaiModel: e.OPENAI_MODEL,
  };
}
