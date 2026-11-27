import type { AiConfig } from "./config";
import { retryConfig, withJitter, type RetryConfig } from "./retry-config";
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
  sleep?: (ms: number) => Promise<void>; // test seam
  retry?: Partial<RetryConfig>; // test seam; the defaults come from retryConfig() (environment variables)
  random?: () => number; // test seam (jitter)
  now?: () => number; // test seam (the retry time budget)
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

const MAX_ATTEMPTS = 2; // for output that fails validation (models occasionally slip)

/** The provider is briefly overloaded or unreachable (not a bad key, not a bad request): worth waiting and trying again. */
export const isTransientProviderError = (e: unknown): boolean =>
  /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e instanceof Error ? e.message : String(e));

/** Transient errors plus rate limits and quota ("429 RESOURCE_EXHAUSTED"): trying again later can work. A refused key never matches. */
export const isRetryableProviderError = (e: unknown): boolean =>
  isTransientProviderError(e) || /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(e instanceof Error ? e.message : String(e));

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
  const { provider, config } = input;
  const apiKey = provider === "gemini" ? config.geminiApiKey : config.openaiApiKey;
  const model = provider === "gemini" ? config.geminiModel : config.openaiModel;
  if (!apiKey) throw new AiProviderError(`No API key configured for ${provider}`);

  const adapter = (input.adapters ?? ADAPTERS)[provider];
  const turns = mergeTurns([...input.history, { role: "user", text: input.userTurn }]);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let problem = "no output";

  const cfg: RetryConfig = { ...retryConfig(), ...input.retry };
  const clock = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const startedAt = clock();
  let retries = 0; // provider-outage retries used
  let invalid = 0; // outputs that failed validation

  while (invalid < MAX_ATTEMPTS) {
    let raw;
    try {
      raw = await adapter({
        apiKey, model, turns,
        system: input.system,
        jsonSchema: REPLY_JSON_SCHEMA,
        maxOutputTokens: 2048,
        timeoutMs: 25_000,
      });
    } catch (e) {
      // A brief provider outage ("high demand") is waited out: a few more tries with growing pauses (and some randomness), as long as
      // the time budget allows. Anything else (a refused key, a bad request) is thrown straight away so the caller can react to it.
      if (isRetryableProviderError(e) && retries < cfg.delaysMs.length) {
        const delay = withJitter(cfg.delaysMs[retries], input.random);
        if (clock() - startedAt + delay < cfg.budgetMs) {
          retries++;
          problem = "provider temporarily unavailable";
          await sleep(delay);
          continue;
        }
      }
      throw e;
    }
    usage.inputTokens += raw.inputTokens;
    usage.outputTokens += raw.outputTokens;

    const parsed = parseModelOutput(raw.text);
    if (parsed.ok) return { result: parsed.value, usage, provider, model };
    problem = parsed.problem; // try once more; models occasionally slip
    invalid++;
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
