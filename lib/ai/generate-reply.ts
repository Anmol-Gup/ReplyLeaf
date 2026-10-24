import type { AiConfig } from "./config";
import { ADAPTERS, AiProviderError, type Adapter, type ChatTurn, type Provider } from "./providers";
import { REPLY_JSON_SCHEMA, ReplySchema, type ReplyResult } from "./schema";

// The ONE internal entry point for getting a reply from a model.
// Provider differences live in providers.ts; everything the rest of the app
// sees is the validated ReplyResult plus token usage.

export type Usage = { inputTokens: number; outputTokens: number };

export type GenerateReplyInput = {
  provider: Provider;
  config: AiConfig;
  system: string; // from buildSystemPrompt()
  history: ChatTurn[]; // earlier turns (customer turns already wrapped)
  userTurn: string; // current customer messages, from wrapCustomerMessages()
  adapters?: Record<Provider, Adapter>; // test seam
};

export type GenerateReplyOutput = {
  result: ReplyResult;
  usage: Usage;
  provider: Provider;
  model: string;
};

// Thrown when the model never produced valid output. Carries the tokens spent.
export class InvalidModelOutputError extends Error {
  constructor(message: string, readonly usage: Usage, readonly provider: Provider, readonly model: string) {
    super(message);
  }
}

const MAX_ATTEMPTS = 2;

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
  const { provider, config } = input;
  const apiKey = provider === "gemini" ? config.geminiApiKey : config.openaiApiKey;
  const model = provider === "gemini" ? config.geminiModel : config.openaiModel;
  if (!apiKey) throw new AiProviderError(`No API key configured for ${provider}`);

  const adapter = (input.adapters ?? ADAPTERS)[provider];
  const turns = mergeTurns([...input.history, { role: "user", text: input.userTurn }]);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let problem = "no output";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await adapter({
      apiKey, model, turns,
      system: input.system,
      jsonSchema: REPLY_JSON_SCHEMA,
      maxOutputTokens: 2048,
      timeoutMs: 25_000,
    });
    usage.inputTokens += raw.inputTokens;
    usage.outputTokens += raw.outputTokens;

    const parsed = parseModelOutput(raw.text);
    if (parsed.ok) return { result: parsed.value, usage, provider, model };
    problem = parsed.problem; // try once more; models occasionally slip
  }
  throw new InvalidModelOutputError(`Model output failed validation: ${problem}`, usage, provider, model);
}

// JSON.parse + Zod. Nothing downstream sees anything that skipped this.
export function parseModelOutput(
  text: string | null,
): { ok: true; value: ReplyResult } | { ok: false; problem: string } {
  if (!text) return { ok: false, problem: "empty response" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not valid JSON" };
  }
  const result = ReplySchema.safeParse(json);
  if (!result.success) {
    return { ok: false, problem: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: result.data };
}

// Providers want alternating roles; join consecutive same-role turns.
function mergeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text += `\n${t.text}`;
    else out.push({ ...t });
  }
  return out;
}
