// Pure helpers for businesses' own AI keys (unit-tested). Keys are SECRETS: nothing in here logs one, and the
// callers never send one to the browser.

export type KeyProvider = "gemini" | "openai";
export const KEY_PROVIDERS: readonly KeyProvider[] = ["gemini", "openai"];
export const PROVIDER_LABELS: Record<KeyProvider, string> = { gemini: "Google Gemini", openai: "OpenAI" };

export type AiMode = "byok" | "platform";
export type KeyStatus = "none" | "valid" | "unverified" | "invalid";

const FORMATS: Record<KeyProvider, RegExp> = {
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,        // includes sk-proj-... keys
  gemini: /^(AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{30,})$/, // classic "AIza..." keys and the newer "AQ...." keys
};

/** Trims, and checks the shape for the chosen provider before anything is sent anywhere. */
export function checkKeyFormat(provider: KeyProvider, raw: unknown): { ok: true; key: string } | { ok: false; reason: "empty" | "format" } {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const key = raw.trim();
  if (!key) return { ok: false, reason: "empty" };
  if (key.length > 300 || !FORMATS[provider].test(key)) return { ok: false, reason: "format" };
  return { ok: true, key };
}

/** "····wxyz": the only part of a key that is ever shown or stored in the clear. */
export const lastFour = (key: string) => key.slice(-4);
export const maskedKey = (last4: string | null | undefined) => (last4 ? `····${last4}` : "");

/** Can the assistant call the AI for this business right now? Platform mode always can; BYOK needs a key that is not known-bad. */
export function aiUsable(mode: AiMode, hasKey: boolean, status: KeyStatus): boolean {
  return mode === "platform" || (hasKey && status !== "invalid" && status !== "none");
}

/** Which problem to tell the owner about, or null when the key is fine (or not needed). */
export function keyProblem(mode: AiMode, hasKey: boolean, status: KeyStatus): "missing" | "invalid" | null {
  if (mode !== "byok") return null;
  if (!hasKey || status === "none") return "missing";
  return status === "invalid" ? "invalid" : null;
}

/** Did the provider refuse the KEY (as opposed to a busy server, a quota limit, or a bad request)? Looks at the status
 *  and the provider's wording only; never at anything that could contain the key. */
export function isAuthFailure(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : typeof e?.code === "number" ? e.code : null;
  if (status === 401 || status === 403) return true;
  const text = `${typeof e?.message === "string" ? e.message : String(err ?? "")}`.toLowerCase();
  return /api key not valid|api_key_invalid|invalid_api_key|incorrect api key|invalid x-api-key|permission_denied|unauthenticated|"status":\s*"unauthenticated"|authentication/.test(text) && !/quota|rate limit|resource_exhausted/.test(text);
}

/** At most one owner email per day about the same key problem. */
export const KEY_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const shouldEmailKeyProblem = (lastNotifiedAt: Date | null, now: Date) =>
  !lastNotifiedAt || now.getTime() - lastNotifiedAt.getTime() >= KEY_EMAIL_INTERVAL_MS;
