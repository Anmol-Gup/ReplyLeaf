// Server-side steps of Embedded Signup (v4), following Meta's Tech Provider guide:
//   1. exchange the 30-second `code` for the customer's business token
//   2. confirm that token can actually reach the phone number we were told about
//   3. subscribe OUR app to the customer's WABA so its webhooks reach us
//   4. register the number (sets its two-step-verification PIN)
//
// !! Real customers can only complete this after Meta approves us as a Tech
// !! Provider (App Review with advanced access to whatsapp_business_management
// !! and whatsapp_business_messaging). Until then it only works for people with
// !! a role on our own Meta app. Never log tokens, codes or the app secret.

export class OnboardingError extends Error {
  constructor(readonly step: "token_exchange" | "phone_access" | "subscribe" | "register", message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;
const base = (v: string) => `https://graph.facebook.com/${v}`;

async function graphError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return `${res.status}: ${j?.error?.message ?? "unknown error"}`;
}

export async function exchangeCodeForToken(
  o: { graphVersion: string; appId: string; appSecret: string; code: string }, f: Fetch = fetch,
): Promise<string> {
  const url = new URL(`${base(o.graphVersion)}/oauth/access_token`);
  url.searchParams.set("client_id", o.appId);
  url.searchParams.set("client_secret", o.appSecret);
  url.searchParams.set("code", o.code);
  const res = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OnboardingError("token_exchange", await graphError(res)); // never includes the URL
  const body = (await res.text()).trim();
  // Meta documents a plain-text token; the Graph API normally returns JSON. Accept both.
  let token: string | undefined;
  try {
    token = (JSON.parse(body) as { access_token?: string }).access_token;
  } catch {
    token = /^[A-Za-z0-9_-]{20,}$/.test(body) ? body : undefined;
  }
  if (!token) throw new OnboardingError("token_exchange", "no access token in response");
  return token;
}

/** Proves the token can read this phone number (so a client can't claim someone else's number). */
export async function verifyPhoneAccess(
  o: { graphVersion: string; token: string; phoneNumberId: string }, f: Fetch = fetch,
): Promise<void> {
  const res = await f(`${base(o.graphVersion)}/${encodeURIComponent(o.phoneNumberId)}?fields=id`, {
    headers: { Authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OnboardingError("phone_access", await graphError(res));
}

export async function subscribeAppToWaba(
  o: { graphVersion: string; token: string; wabaId: string }, f: Fetch = fetch,
): Promise<void> {
  const res = await f(`${base(o.graphVersion)}/${encodeURIComponent(o.wabaId)}/subscribed_apps`, {
    method: "POST", headers: { Authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OnboardingError("subscribe", await graphError(res));
  const j = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (j?.success !== true) throw new OnboardingError("subscribe", "subscription was not confirmed");
}

export async function registerPhoneNumber(
  o: { graphVersion: string; token: string; phoneNumberId: string; pin: string }, f: Fetch = fetch,
): Promise<void> {
  const res = await f(`${base(o.graphVersion)}/${encodeURIComponent(o.phoneNumberId)}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin: o.pin }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OnboardingError("register", await graphError(res));
}
