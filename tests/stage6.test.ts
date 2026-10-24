import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDailyCheck, type CheckRow } from "../lib/checks";
import { isCronAuthorized } from "../lib/cron";
import { makeState, verifyState } from "../lib/onboarding-state";
import {
  exchangeCodeForToken, OnboardingError, registerPhoneNumber, subscribeAppToWaba, verifyPhoneAccess,
} from "../lib/whatsapp/onboarding";

// ------------------------------------------------------------ onboarding state
const SECRET = "app-secret";
const T0 = 1_700_000_000_000;

test("onboarding state: valid for the same user within 30 minutes", () => {
  const s = makeState("user-1", SECRET, T0);
  assert.equal(verifyState(s, "user-1", SECRET, T0 + 60_000), true);
});
test("onboarding state: rejected when expired, for another user, tampered, or from the future", () => {
  const s = makeState("user-1", SECRET, T0);
  assert.equal(verifyState(s, "user-1", SECRET, T0 + 31 * 60_000), false);
  assert.equal(verifyState(s, "user-2", SECRET, T0 + 1000), false);
  assert.equal(verifyState(s, "user-1", "other-secret", T0 + 1000), false);
  assert.equal(verifyState(s.slice(0, -2) + "xx", "user-1", SECRET, T0 + 1000), false);
  assert.equal(verifyState(s, "user-1", SECRET, T0 - 120_000), false);
  assert.equal(verifyState("garbage", "user-1", SECRET, T0), false);
  assert.equal(verifyState("", "user-1", SECRET, T0), false);
});

// ------------------------------------------------------------------ cron auth
const req = (auth?: string) => new Request("https://x.test/api/cron/x", { headers: auth ? { authorization: auth } : {} });
test("cron routes refuse without a long enough secret or the right header", () => {
  const secret = "a-long-random-secret-123";
  assert.equal(isCronAuthorized(req(`Bearer ${secret}`), secret), true);
  assert.equal(isCronAuthorized(req(`Bearer wrong-secret-of-same-len`), secret), false);
  assert.equal(isCronAuthorized(req(), secret), false);
  assert.equal(isCronAuthorized(req("Bearer "), secret), false);
  assert.equal(isCronAuthorized(req("Bearer short"), "short"), false); // too-short secret disables the route
  assert.equal(isCronAuthorized(req("Bearer anything"), undefined), false);
});

// --------------------------------------------------------------- daily check
const row = (over: Partial<CheckRow> = {}): CheckRow => ({
  out_client_id: "c", out_client_name: "Biz", out_received: 10, out_replied: 10, out_unreplied: 0, out_failed: 0, out_stuck: 0, ...over,
});
test("daily check: healthy clients produce no issues but still report received vs replied", () => {
  const s = summarizeDailyCheck([row()]);
  assert.equal(s.hasIssues, false);
  assert.match(s.text, /Biz: received 10, replied 10/);
});
test("daily check: unreplied conversations, failures and stuck batches are flagged (numbers may arrive as strings)", () => {
  const s = summarizeDailyCheck([row(), row({ out_client_name: "Bad", out_unreplied: "2", out_failed: 1, out_stuck: "1" })]);
  assert.equal(s.hasIssues, true);
  assert.equal(s.issueCount, 1);
  assert.match(s.text, /PROBLEM {2}Bad: .*2 conversation\(s\) with no reply, 1 failed\/blocked send\(s\), 1 stuck batch\(es\)/);
});
test("daily check: no clients is not an issue", () => {
  assert.equal(summarizeDailyCheck([]).hasIssues, false);
});

// ------------------------------------------------------ Embedded Signup calls
type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: { status?: number; json?: unknown; text?: string }[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 200, json: {} };
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status });
  }) as typeof fetch;
  return { f, calls };
}
const base = { graphVersion: "v26.0" };

test("code exchange: calls the oauth endpoint and returns the token (JSON or plain text)", async () => {
  const json = fakeFetch([{ json: { access_token: "EAAB-token-value-0123456789" } }]);
  assert.equal(await exchangeCodeForToken({ ...base, appId: "123", appSecret: "shh", code: "the-code" }, json.f), "EAAB-token-value-0123456789");
  const u = new URL(json.calls[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.facebook.com/v26.0/oauth/access_token");
  assert.deepEqual([u.searchParams.get("client_id"), u.searchParams.get("code")], ["123", "the-code"]);

  const text = fakeFetch([{ text: "EAAB_plain_text_token_0123456789" }]);
  assert.equal(await exchangeCodeForToken({ ...base, appId: "1", appSecret: "s", code: "c" }, text.f), "EAAB_plain_text_token_0123456789");
});

test("code exchange failure never leaks the secret, the code, or the URL", async () => {
  const { f } = fakeFetch([{ status: 400, json: { error: { message: "Invalid verification code format." } } }]);
  await assert.rejects(
    exchangeCodeForToken({ ...base, appId: "1", appSecret: "TOP-SECRET", code: "SECRET-CODE" }, f),
    (e: unknown) => e instanceof OnboardingError && e.step === "token_exchange"
      && !/TOP-SECRET|SECRET-CODE|client_secret/.test(e.message) && /Invalid verification code/.test(e.message),
  );
  const empty = fakeFetch([{ json: {} }]);
  await assert.rejects(exchangeCodeForToken({ ...base, appId: "1", appSecret: "s", code: "c" }, empty.f), /no access token/);
});

test("phone access check uses the new token as a Bearer header and rejects when it cannot read the number", async () => {
  const ok = fakeFetch([{ json: { id: "55" } }]);
  await verifyPhoneAccess({ ...base, token: "tok", phoneNumberId: "55" }, ok.f);
  assert.equal(ok.calls[0].url, "https://graph.facebook.com/v26.0/55?fields=id");
  assert.equal((ok.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok");
  const denied = fakeFetch([{ status: 403, json: { error: { message: "(#10) no permission" } } }]);
  await assert.rejects(verifyPhoneAccess({ ...base, token: "tok", phoneNumberId: "99" }, denied.f), (e: unknown) => e instanceof OnboardingError && e.step === "phone_access");
});

test("subscribe: POSTs to the WABA's subscribed_apps and requires success:true", async () => {
  const ok = fakeFetch([{ json: { success: true } }]);
  await subscribeAppToWaba({ ...base, token: "tok", wabaId: "777" }, ok.f);
  assert.equal(ok.calls[0].url, "https://graph.facebook.com/v26.0/777/subscribed_apps");
  assert.equal(ok.calls[0].init?.method, "POST");
  const no = fakeFetch([{ json: { success: false } }]);
  await assert.rejects(subscribeAppToWaba({ ...base, token: "tok", wabaId: "777" }, no.f), /not confirmed/);
});

test("register: sends messaging_product and the 6-digit pin", async () => {
  const ok = fakeFetch([{ json: { success: true } }]);
  await registerPhoneNumber({ ...base, token: "tok", phoneNumberId: "55", pin: "123456" }, ok.f);
  assert.equal(ok.calls[0].url, "https://graph.facebook.com/v26.0/55/register");
  assert.deepEqual(JSON.parse(String(ok.calls[0].init?.body)), { messaging_product: "whatsapp", pin: "123456" });
  const bad = fakeFetch([{ status: 400, json: { error: { message: "bad pin" } } }]);
  await assert.rejects(registerPhoneNumber({ ...base, token: "t", phoneNumberId: "55", pin: "1" }, bad.f), (e: unknown) => e instanceof OnboardingError && e.step === "register");
});

test("ids are URL-encoded so a crafted id cannot change the request path", async () => {
  const { f, calls } = fakeFetch([{ json: { success: true } }]);
  await subscribeAppToWaba({ ...base, token: "t", wabaId: "1/../../x" }, f);
  assert.ok(!calls[0].url.includes("/../"));
});
