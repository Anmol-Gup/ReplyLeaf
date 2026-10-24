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

export type OnboardingStep = "token_exchange" | "phone_access" | "subscribe" | "register" | "token_refresh";

export class OnboardingError extends Error {
  constructor(readonly step: OnboardingStep, message: string) {
    super(message);
  }
}

export type IssuedToken = {
  token: string;
  /** Seconds until expiry if Meta told us, otherwise undefined (see DOCS UNCLEAR below). */
  expiresInSeconds?: number;
};

// The business token is configured in the Meta portal to expire after 60 days.
export const ASSUMED_TOKEN_LIFETIME_SECONDS = 60 * 24 * 60 * 60;

type Fetch = typeof fetch;
const base = (v: string) => `https://graph.facebook.com/${v}`;

async function graphError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return `${res.status}: ${j?.error?.message ?? "unknown error"}`;
}

// DOCS UNCLEAR: Meta's Embedded Signup guide documents the request but not the response
// body, so we do not know whether `expires_in` is returned. If it is, we use it; if not,
// the caller assumes 60 days (the portal setting) and records that the expiry was assumed.
export async function exchangeCodeForToken(
  o: { graphVersion: string; appId: string; appSecret: string; code: string }, f: Fetch = fetch,
): Promise<IssuedToken> {
  const url = new URL(`${base(o.graphVersion)}/oauth/access_token`);
  url.searchParams.set("client_id", o.appId);
  url.searchParams.set("client_secret", o.appSecret);
  url.searchParams.set("code", o.code);
  const res = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OnboardingError("token_exchange", await graphError(res)); // never includes the URL
  const body = (await res.text()).trim();
  // Meta documents a plain-text token; the Graph API normally returns JSON. Accept both.
  return parseTokenResponse(body, "token_exchange");
}

function parseTokenResponse(body: string, step: OnboardingStep): IssuedToken {
  let token: string | undefined;
  let expiresIn: number | undefined;
  try {
    const j = JSON.parse(body) as { access_token?: string; expires_in?: number };
    token = j.access_token;
    if (typeof j.expires_in === "number" && j.expires_in > 0) expiresIn = j.expires_in;
  } catch {
    token = /^[A-Za-z0-9_-]{20,}$/.test(body) ? body : undefined;
  }
  if (!token) throw new OnboardingError(step, "no access token in response");
  return { token, expiresInSeconds: expiresIn };
}

/**
 * Extends an expiring (60-day) token. Uses the documented fb_exchange_token grant from
 * Meta's "Install apps, generate, refresh and revoke tokens" page, which returns
 * access_token + expires_in. The old token keeps working until its own expiry.
 *
 * DOCS UNCLEAR: that page is written for system-user tokens and does not say whether it
 * applies to the business token returned by Embedded Signup. Treat the first real refresh
 * as an experiment: if it fails, the daily job alerts the admin and the customer must
 * reconnect through Embedded Signup (the only route Meta documents for a new token).
 */
export async function refreshBusinessToken(
  o: { graphVersion: string; appId: string; appSecret: string; token: string }, f: Fetch = fetch,
): Promise<IssuedToken> {
  const url = new URL(`${base(o.graphVersion)}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", o.appId);
  url.searchParams.set("client_secret", o.appSecret);
  url.searchParams.set("set_token_expires_in_60_days", "true");
  url.searchParams.set("fb_exchange_token", o.token);
  const res = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OnboardingError("token_refresh", await graphError(res)); // never includes the URL
  return parseTokenResponse((await res.text()).trim(), "token_refresh");
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
