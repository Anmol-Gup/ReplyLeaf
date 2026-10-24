import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDailyCheck, type CheckRow } from "../lib/checks";
import { isCronAuthorized } from "../lib/cron";
import { makeState, verifyState } from "../lib/onboarding-state";
import { IN_PROGRESS_WINDOW_MS, planOnboarding, STEP_REASONS, type ClientRow } from "../lib/onboarding-plan";
import { parseWebhookPayload } from "../lib/whatsapp/payload";
import { refreshExpiringTokens, REFRESH_WITHIN_DAYS, type RefreshDeps } from "../lib/token-refresh";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { randomBytes } from "node:crypto";
import {
  exchangeCodeForToken, OnboardingError, refreshBusinessToken, registerPhoneNumber, subscribeAppToWaba, verifyPhoneAccess,
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
  assert.deepEqual(await exchangeCodeForToken({ ...base, appId: "123", appSecret: "shh", code: "the-code" }, json.f), { token: "EAAB-token-value-0123456789", expiresInSeconds: undefined });
  const u = new URL(json.calls[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.facebook.com/v26.0/oauth/access_token");
  assert.deepEqual([u.searchParams.get("client_id"), u.searchParams.get("code")], ["123", "the-code"]);

  const text = fakeFetch([{ text: "EAAB_plain_text_token_0123456789" }]);
  assert.equal((await exchangeCodeForToken({ ...base, appId: "1", appSecret: "s", code: "c" }, text.f)).token, "EAAB_plain_text_token_0123456789");
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

test("code exchange reports expires_in when Meta sends it", async () => {
  const { f } = fakeFetch([{ json: { access_token: "EAAB-token-value-0123456789", expires_in: 5184000 } }]);
  assert.equal((await exchangeCodeForToken({ ...base, appId: "1", appSecret: "s", code: "c" }, f)).expiresInSeconds, 5184000);
});

// ------------------------------------------------------------- token refresh call
test("refresh uses the documented fb_exchange_token grant and returns the new expiry", async () => {
  const { f, calls } = fakeFetch([{ json: { access_token: "EAAB-new-token-value-0123456789", token_type: "bearer", expires_in: 5183999 } }]);
  const out = await refreshBusinessToken({ ...base, appId: "123", appSecret: "shh", token: "old-token-value" }, f);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.facebook.com/v26.0/oauth/access_token");
  assert.deepEqual(
    ["grant_type", "client_id", "set_token_expires_in_60_days", "fb_exchange_token"].map((k) => u.searchParams.get(k)),
    ["fb_exchange_token", "123", "true", "old-token-value"],
  );
  assert.deepEqual(out, { token: "EAAB-new-token-value-0123456789", expiresInSeconds: 5183999 });
});

test("refresh failure is an OnboardingError that leaks neither secret nor tokens", async () => {
  const { f } = fakeFetch([{ status: 400, json: { error: { message: "Error validating access token" } } }]);
  await assert.rejects(
    refreshBusinessToken({ ...base, appId: "1", appSecret: "TOP-SECRET", token: "OLD-TOKEN" }, f),
    (e: unknown) => e instanceof OnboardingError && e.step === "token_refresh" && !/TOP-SECRET|OLD-TOKEN/.test(e.message),
  );
});

// ----------------------------------------------------------- token encryption
test("tokens are stored encrypted, never as plaintext, and round-trip", () => {
  const key = randomBytes(32).toString("base64");
  const token = "EAAB-business-token-0123456789";
  const stored = encryptSecret(token, key);
  assert.ok(!stored.includes(token) && !stored.includes("EAAB"));
  assert.equal(decryptSecret(stored, key), token);
  assert.throws(() => decryptSecret(stored, randomBytes(32).toString("base64")));
});

// ----------------------------------------------- onboarding plan (idempotency + ownership)
const NOW = new Date("2026-01-02T12:00:00Z");
const clientRow = (over: Partial<ClientRow> = {}): ClientRow => ({ id: "c1", onboardingStatus: "connected", onboardingStep: "confirmed", updatedAt: new Date(NOW.getTime() - 3_600_000), ...over });
const plan = (i: Parameters<typeof planOnboarding>[0]) => planOnboarding(i, NOW);

test("plan: a brand-new login with a free WABA and number creates a client", () => {
  assert.deepEqual(plan({ mine: null, wabaOwner: null, phoneOwner: null }), { action: "create" });
});

test("plan: duplicate WABA is rejected when it belongs to a DIFFERENT client", () => {
  assert.deepEqual(plan({ mine: null, wabaOwner: clientRow({ id: "other" }), phoneOwner: null }), { action: "conflict", what: "waba" });
  assert.deepEqual(plan({ mine: clientRow({ onboardingStatus: "failed" }), wabaOwner: clientRow({ id: "other" }), phoneOwner: null }), { action: "conflict", what: "waba" });
});

test("plan: duplicate phone number is rejected when it belongs to a different client", () => {
  assert.deepEqual(plan({ mine: null, wabaOwner: null, phoneOwner: clientRow({ id: "other" }) }), { action: "conflict", what: "phone" });
  assert.deepEqual(plan({ mine: clientRow(), wabaOwner: clientRow(), phoneOwner: clientRow({ id: "other" }) }), { action: "conflict", what: "phone" });
});

test("plan: a connected client cannot be connected again (no duplicate client)", () => {
  assert.deepEqual(plan({ mine: clientRow(), wabaOwner: clientRow(), phoneOwner: clientRow() }), { action: "already_connected" });
  assert.deepEqual(plan({ mine: clientRow({ onboardingStatus: "manual", onboardingStep: null }), wabaOwner: null, phoneOwner: null }), { action: "already_connected" });
  assert.deepEqual(plan({ mine: clientRow({ onboardingStatus: "pending", onboardingStep: "complete" }), wabaOwner: null, phoneOwner: null }), { action: "already_connected" });
});

test("plan: a failed onboarding resumes the SAME client, even with new WABA/number ids", () => {
  assert.deepEqual(plan({ mine: clientRow({ onboardingStatus: "failed", onboardingStep: "subscribe" }), wabaOwner: null, phoneOwner: null }), { action: "resume", clientId: "c1" });
  // the retry hits its own row via the WABA/phone lookup: that is not a conflict
  assert.deepEqual(plan({ mine: clientRow({ onboardingStatus: "failed" }), wabaOwner: clientRow({ onboardingStatus: "failed" }), phoneOwner: clientRow({ onboardingStatus: "failed" }) }), { action: "resume", clientId: "c1" });
});

test("plan: a running flow blocks a double submit; a crashed one can be resumed", () => {
  const running = clientRow({ onboardingStatus: "pending", onboardingStep: "subscribe", updatedAt: new Date(NOW.getTime() - 10_000) });
  assert.deepEqual(plan({ mine: running, wabaOwner: null, phoneOwner: null }), { action: "in_progress" });
  const stale = clientRow({ onboardingStatus: "pending", onboardingStep: "subscribe", updatedAt: new Date(NOW.getTime() - IN_PROGRESS_WINDOW_MS - 1) });
  assert.deepEqual(plan({ mine: stale, wabaOwner: null, phoneOwner: null }), { action: "resume", clientId: "c1" });
  const never = clientRow({ onboardingStatus: "pending", onboardingStep: "started", updatedAt: null });
  assert.deepEqual(plan({ mine: never, wabaOwner: null, phoneOwner: null }), { action: "resume", clientId: "c1" });
});

test("every onboarding step has a plain-language reason for the owner", () => {
  for (const s of ["token_exchange", "phone_access", "subscribe", "register", "save", "token_expired", "token_refresh", "partner_removed"]) assert.ok(STEP_REASONS[s], s);
});

// ------------------------------------------------------- account_update webhook parsing
const accountUpdate = (entryId: string, value: unknown) => ({ object: "whatsapp_business_account", entry: [{ id: entryId, changes: [{ field: "account_update", value }] }] });

test("account_update PARTNER_ADDED uses waba_info.waba_id (entry.id is the business portfolio)", () => {
  const r = parseWebhookPayload(accountUpdate("999111222", { event: "PARTNER_ADDED", waba_info: { waba_id: "55566677", owner_business_id: "999111222" } }));
  assert.deepEqual(r.accountEvents, [{ wabaId: "55566677", event: "PARTNER_ADDED" }]);
  assert.equal(r.messages.length + r.statuses.length, 0);
});

test("other account_update events use entry.id as the WABA id; bad ids are ignored", () => {
  assert.deepEqual(parseWebhookPayload(accountUpdate("55566677", { event: "PARTNER_REMOVED" })).accountEvents, [{ wabaId: "55566677", event: "PARTNER_REMOVED" }]);
  assert.equal(parseWebhookPayload(accountUpdate("not-a-number", { event: "PARTNER_ADDED" })).accountEvents.length, 0);
  assert.equal(parseWebhookPayload(accountUpdate("55566677", { nope: true })).accountEvents.length, 0);
});

// -------------------------------------------------------- daily token refresh job
const DAY = 86_400_000;
function refreshDeps(tokens: { clientId: string; clientName: string; daysLeft: number }[], failFor: string[] = []) {
  const log = { refreshed: [] as string[], expired: [] as string[], alerts: [] as string[], asked: 0 };
  const deps: RefreshDeps = {
    now: () => NOW,
    listExpiring: async (days) => { log.asked = days; return tokens.map((t) => ({ clientId: t.clientId, clientName: t.clientName, expiresAt: new Date(NOW.getTime() + t.daysLeft * DAY) })); },
    refresh: async (id) => { if (failFor.includes(id)) throw new Error("Error validating access token"); log.refreshed.push(id); return { expiresAt: new Date(NOW.getTime() + 60 * DAY), assumed: false }; },
    markExpired: async (id) => void log.expired.push(id),
    alert: async (id, kind) => void log.alerts.push(`${id}:${kind}`),
  };
  return { deps, log };
}

test("refresh job: asks for tokens expiring within 14 days and refreshes them", async () => {
  const { deps, log } = refreshDeps([{ clientId: "a", clientName: "A", daysLeft: 10 }, { clientId: "b", clientName: "B", daysLeft: 1 }]);
  const report = await refreshExpiringTokens(deps);
  assert.equal(log.asked, REFRESH_WITHIN_DAYS);
  assert.deepEqual(log.refreshed, ["a", "b"]);
  assert.deepEqual(report, { checked: 2, refreshed: 2, failed: 0, expired: 0 });
  assert.equal(log.alerts.length, 0);
});

test("refresh job: a failed refresh alerts the admin and does not stop the others", async () => {
  const { deps, log } = refreshDeps([{ clientId: "a", clientName: "A", daysLeft: 5 }, { clientId: "b", clientName: "B", daysLeft: 5 }], ["a"]);
  const report = await refreshExpiringTokens(deps);
  assert.deepEqual(log.alerts, ["a:token_refresh_failed"]);
  assert.deepEqual(log.refreshed, ["b"]);
  assert.deepEqual(report, { checked: 2, refreshed: 1, failed: 1, expired: 0 });
});

test("refresh job: an already-expired token is marked failed for the owner, alerted, and NOT refreshed", async () => {
  const { deps, log } = refreshDeps([{ clientId: "a", clientName: "A", daysLeft: -1 }]);
  const report = await refreshExpiringTokens(deps);
  assert.deepEqual(log.expired, ["a"]);
  assert.deepEqual(log.alerts, ["a:token_expired"]);
  assert.equal(log.refreshed.length, 0);
  assert.equal(report.expired, 1);
});

test("refresh job: nothing expiring is a quiet no-op", async () => {
  const { deps, log } = refreshDeps([]);
  assert.deepEqual(await refreshExpiringTokens(deps), { checked: 0, refreshed: 0, failed: 0, expired: 0 });
  assert.equal(log.alerts.length, 0);
});
