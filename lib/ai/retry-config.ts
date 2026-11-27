// Settings for riding out a provider that is briefly overloaded (Gemini "503 high demand"). Pure, so it is unit-tested.
//   delaysMs             pauses between tries INSIDE one run (each one is a retry), with a little randomness added (jitter)
//   budgetMs             stop retrying inside a run after this long (the webhook's background work has about 60 s in total)
//   rescueDelaySeconds   if the run still failed, the customer's message stays queued and is tried again after this long
//   rescueWindowMs       keep trying that way for this long; after it the chat is handed to a person
// Every value can be changed with an environment variable; nothing here is a secret.

export type RetryConfig = { delaysMs: number[]; budgetMs: number; rescueDelaySeconds: number; rescueWindowMs: number };

export const DEFAULT_RETRY: RetryConfig = { delaysMs: [2000, 5000, 10000, 20000], budgetMs: 40_000, rescueDelaySeconds: 45, rescueWindowMs: 10 * 60 * 1000 };

const num = (raw: string | undefined, min: number, max: number): number | null => {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export function retryConfig(env: Record<string, string | undefined> = process.env): RetryConfig {
  let delaysMs = DEFAULT_RETRY.delaysMs;
  const list = env.AI_RETRY_DELAYS_MS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (list && list.length <= 10) {
    const parsed = list.map((s) => num(s, 0, 60_000));
    if (parsed.every((n): n is number => n !== null)) delaysMs = parsed;
  }
  return {
    delaysMs,
    budgetMs: num(env.AI_RETRY_BUDGET_MS, 1000, 55_000) ?? DEFAULT_RETRY.budgetMs,
    rescueDelaySeconds: num(env.AI_RESCUE_DELAY_SECONDS, 5, 600) ?? DEFAULT_RETRY.rescueDelaySeconds,
    rescueWindowMs: (num(env.AI_RESCUE_WINDOW_MINUTES, 1, 60) ?? 10) * 60 * 1000,
  };
}

/** A delay with +-20% randomness, so many chats do not all retry at the same instant. `random` is injectable for tests. */
export const withJitter = (ms: number, random: () => number = Math.random): number => Math.round(ms * (0.8 + random() * 0.4));

/** Provider errors can echo parts of a request. Never let a key reach a log line, an alert or an email. */
export function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    .replace(/(api[_-]?key|x-goog-api-key|authorization|bearer)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[redacted]");
}
