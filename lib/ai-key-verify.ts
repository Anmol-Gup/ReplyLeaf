import type { KeyProvider, KeyStatus } from "./ai-keys";

// Checks a business's key with the provider's free "list models" call (no tokens are used). The key goes in a
// request header, never in a URL, and is never logged. Returns:
//   valid       the provider accepted it
//   invalid     the provider refused it (wrong or revoked key)
//   unverified  we could not tell (network problem, provider outage, rate limit): it can be saved and is retried when used
type Fetch = typeof fetch;

export async function verifyKey(provider: KeyProvider, key: string, doFetch: Fetch = fetch): Promise<Extract<KeyStatus, "valid" | "invalid" | "unverified">> {
  try {
    const res = provider === "openai"
      ? await doFetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
      : await doFetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return "valid";
    if (res.status === 401 || res.status === 403) return "invalid";
    if (provider === "gemini" && res.status === 400) {
      const body = (await res.text().catch(() => "")).toLowerCase();
      if (body.includes("api_key_invalid") || body.includes("api key not valid")) return "invalid"; // Gemini answers a bad key with a 400
    }
    return "unverified";
  } catch {
    return "unverified";
  }
}
