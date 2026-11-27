import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReply, isRetryableProviderError } from "../lib/ai/generate-reply";
import { DEFAULT_RETRY, redactSecrets, retryConfig, withJitter } from "../lib/ai/retry-config";
import { aiConfig } from "../lib/ai/config";
import type { Adapter } from "../lib/ai/providers";
import {
  CAP_REPLY, FALLBACK_REPLY, processConversationBatch,
  type BatchContext, type BatchDeps, type SaveReply,
} from "../lib/batch";
import type { ReplyResult } from "../lib/ai/schema";
import type { OwnerEvent } from "../lib/email/templates";
import { WINDOW_MS } from "../lib/whatsapp/window";
import { DEFAULT_WORKFLOW_SETTINGS } from "../lib/workflow-settings";
import { baseReply } from "./fixtures";

// Riding out a provider that is briefly overloaded (Gemini 503): the in-run retries, and the rescue that keeps the customer's message.

const OVERLOAD = '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary.","status":"UNAVAILABLE"}}';
const good = baseReply();
const config = aiConfig({ GEMINI_API_KEY: "k", OPENAI_API_KEY: "k2" });
const base = { provider: "gemini" as const, config, system: "sys", history: [], userTurn: "hi" };
const both = (a: Adapter) => ({ gemini: a, openai: a });
const ok = { text: JSON.stringify(good), inputTokens: 10, outputTokens: 4 };
const MID = () => 0.5; // jitter factor exactly 1.0, so the delays are exactly the configured ones

// ---------- generateReply: in-run retries ----------
test("1. Gemini succeeds on the first attempt: no waiting", async () => {
  let calls = 0; const sleeps: number[] = [];
  const out = await generateReply({ ...base, adapters: both(async () => { calls++; return ok; }), sleep: async (ms) => void sleeps.push(ms), random: MID });
  assert.equal(calls, 1); assert.deepEqual(sleeps, []); assert.equal(out.result.reply, good.reply);
});

test("2. one 503, then success on the retry (after the first 2 s pause)", async () => {
  let calls = 0; const sleeps: number[] = [];
  const out = await generateReply({ ...base, adapters: both(async () => { calls++; if (calls === 1) throw new Error(OVERLOAD); return ok; }), sleep: async (ms) => void sleeps.push(ms), random: MID });
  assert.equal(calls, 2); assert.deepEqual(sleeps, [2000]); assert.equal(out.result.reply, good.reply);
});

test("3. repeated 503s, then success: the pauses grow 2 s, 5 s, 10 s", async () => {
  let calls = 0; const sleeps: number[] = [];
  const out = await generateReply({ ...base, adapters: both(async () => { calls++; if (calls <= 3) throw new Error(OVERLOAD); return ok; }), sleep: async (ms) => void sleeps.push(ms), random: MID });
  assert.equal(calls, 4); assert.deepEqual(sleeps, [2000, 5000, 10000]); assert.equal(out.result.reply, good.reply);
});

test("4. every try fails: first try + 4 retries, then the error is thrown with the provider's own words", async () => {
  let calls = 0; const sleeps: number[] = [];
  await assert.rejects(generateReply({ ...base, adapters: both(async () => { calls++; throw new Error(OVERLOAD); }), sleep: async (ms) => void sleeps.push(ms), random: MID }), /high demand/);
  assert.equal(calls, 5); assert.deepEqual(sleeps, [2000, 5000, 10000, 20000]);
});

test("the time budget stops the retries early (the webhook's background work has about 60 s)", async () => {
  let calls = 0; let t = 0; const slept: number[] = [];
  await assert.rejects(generateReply({
    ...base, adapters: both(async () => { calls++; throw new Error(OVERLOAD); }), random: MID,
    now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, retry: { budgetMs: 12_000 },
  }), /503/);
  assert.deepEqual(slept, [2000, 5000]); // 7 s used; the next 10 s pause would pass the 12 s budget, so it stops
  assert.equal(calls, 3);
});

test("5. a refused or invalid key is never retried: one call, thrown at once", async () => {
  for (const msg of ["403 API key not valid. Please pass a valid API key.", "401 Unauthorized", "400 INVALID_ARGUMENT: bad request"]) {
    let calls = 0; const sleeps: number[] = [];
    await assert.rejects(generateReply({ ...base, adapters: both(async () => { calls++; throw new Error(msg); }), sleep: async (ms) => void sleeps.push(ms) }));
    assert.equal(calls, 1, msg); assert.deepEqual(sleeps, [], msg);
  }
});

test("which errors count as a provider outage (waited out) and which do not", () => {
  for (const m of [OVERLOAD, "503 UNAVAILABLE", "502 Bad Gateway", "ECONNRESET", "fetch failed", "429 RESOURCE_EXHAUSTED: quota exceeded", "rate limit reached"]) assert.equal(isRetryableProviderError(new Error(m)), true, m);
  for (const m of ["403 API key not valid", "401 Unauthorized", "400 INVALID_ARGUMENT", "Model output failed validation"]) assert.equal(isRetryableProviderError(new Error(m)), false, m);
});

test("settings: sensible defaults, every value can be changed, nonsense is ignored", () => {
  assert.deepEqual(retryConfig({}), DEFAULT_RETRY);
  const c = retryConfig({ AI_RETRY_DELAYS_MS: "1000, 3000", AI_RETRY_BUDGET_MS: "20000", AI_RESCUE_DELAY_SECONDS: "30", AI_RESCUE_WINDOW_MINUTES: "5" });
  assert.deepEqual(c.delaysMs, [1000, 3000]); assert.equal(c.budgetMs, 20000); assert.equal(c.rescueDelaySeconds, 30); assert.equal(c.rescueWindowMs, 5 * 60_000);
  assert.deepEqual(retryConfig({ AI_RETRY_DELAYS_MS: "abc", AI_RETRY_BUDGET_MS: "-5", AI_RESCUE_DELAY_SECONDS: "0" }), DEFAULT_RETRY);
  for (let i = 0; i < 20; i++) { const j = withJitter(1000); assert.ok(j >= 800 && j <= 1200, String(j)); }
});

test("keys never reach a log line, an alert or an email", () => {
  const gem = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
  assert.doesNotMatch(redactSecrets(`request failed for key=${gem} at https://x?key=${gem}`), /AIza/);
  assert.doesNotMatch(redactSecrets("Incorrect API key provided: sk-proj-abcdefghijklmnop1234"), /sk-proj/);
  assert.doesNotMatch(redactSecrets('{"x-goog-api-key": "secretvalue123"}'), /secretvalue/);
  assert.match(redactSecrets(OVERLOAD), /high demand/); // the diagnosis stays
});

// ---------- the batch worker: keep the customer's message, say "temporary delay" once ----------
const NOW = new Date("2026-01-02T12:00:00Z");
const reply = (over: Partial<ReplyResult> = {}): ReplyResult => baseReply(over);
const ctxOf = (over: Partial<BatchContext> = {}, conv: Partial<BatchContext["conversation"]> = {}): BatchContext => ({
  client: {
    id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100,
    businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open 9-5", workflow: DEFAULT_WORKFLOW_SETTINGS,
    ai: { mode: "platform", apiKey: null, keyStatus: "none" },
    billing: { allowed: true, reason: "active", banner: "none", graceEndsAt: null, paidThrough: null },
  },
  conversation: { id: "conv1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: new Date(NOW.getTime() - 20_000), workflowState: null, ...conv },
  open: { appointments: [], tickets: 0, leads: 0 }, contact: { id: "contact1", name: "Asha" }, phone: "911",
  pending: [{ id: "p1", type: "text", body: "what do you offer?" }], history: [], repliesThisMonth: 0, recentInboundCount: 1,
  retry: { oldestPendingAt: new Date(NOW.getTime() - 20_000), delayNoticeSent: false }, ...over,
});

function deps(ctx: BatchContext, gen: () => Promise<{ result: ReplyResult }>) {
  const log = { sent: [] as string[], saved: [] as SaveReply[], alerts: [] as string[], deferred: [] as number[], completed: [] as string[][], conv: [] as object[], handoffs: [] as { source: string }[], owner: [] as OwnerEvent[], keyReports: 0 };
  const d: BatchDeps = {
    claim: async () => true, load: async () => ctx,
    deferBatch: async (_c, s) => { log.deferred.push(s); return true; },
    complete: async (_c, ids) => { log.completed.push(ids); return false; },
    generate: async () => ({ ...(await gen()), usage: { inputTokens: 1, outputTokens: 1 }, provider: "gemini" as const, model: "m" }),
    sendText: async (_c, body) => { log.sent.push(body); return { waMessageId: `w${log.sent.length}` }; },
    saveReply: async (r) => void log.saved.push(r),
    createHandoff: async (_c, _v, i) => { log.handoffs.push({ source: i.source }); return { created: true }; },
    updateConversation: async (_c, _v, p) => void log.conv.push(p),
    saveAppointment: async () => ({ created: true }), saveLead: async () => ({ created: true }), saveTicket: async () => ({ created: true }),
    saveNotifyEmail: async () => {}, reportSendProblem: async () => {}, recordFailedUsage: async () => {},
    raiseAlert: async (_c, kind) => void log.alerts.push(kind), applyContactDetails: async () => {}, markLead: async () => false,
    notifyOwner: async (_c, e) => void log.owner.push(e), reportAiKeyProblem: async () => void log.keyReports++, logUnanswered: async () => {},
    findDueBatches: async () => [], sleep: async () => {},
  };
  return { d, log };
}
const down = async () => { throw new Error(OVERLOAD); };
const run = (d: BatchDeps) => processConversationBatch("conv1", d, () => NOW);

test("the AI is overloaded: ONE friendly 'temporary delay' notice, the message stays queued, no error alert, no handoff", async () => {
  const f = deps(ctxOf(), down);
  await run(f.d);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]);
  assert.match(FALLBACK_REPLY, /temporary delay/); assert.doesNotMatch(FALLBACK_REPLY, /went wrong|error|sorry/i);
  assert.deepEqual(f.log.deferred, [45]);            // tried again after the rescue delay
  assert.equal(f.log.completed.length, 0);           // the pending message was NOT released: it is kept for the retry
  assert.deepEqual(f.log.alerts, []); assert.equal(f.log.handoffs.length, 0);
});

test("a later retry that fails again does NOT send the notice a second time", async () => {
  const f = deps(ctxOf({ retry: { oldestPendingAt: new Date(NOW.getTime() - 120_000), delayNoticeSent: true } }), down);
  await run(f.d);
  assert.deepEqual(f.log.sent, []); assert.deepEqual(f.log.deferred, [45]); assert.equal(f.log.completed.length, 0);
});

test("restart safety: a fresh worker picks the same queued message up and answers it once the AI is back, with no notice", async () => {
  const f = deps(ctxOf({ retry: { oldestPendingAt: new Date(NOW.getTime() - 120_000), delayNoticeSent: true } }), async () => ({ result: reply({ reply: "We do websites." }) }));
  await run(f.d); // a new process, same stored state
  assert.deepEqual(f.log.sent, ["We do websites."]);
  assert.deepEqual(f.log.completed, [["p1"]]);       // released only after the real answer went out
  assert.deepEqual(f.log.deferred, []);
});

test("every retry over (10 minutes): alert, ONE person-handoff, the owner is emailed, the message is not lost, no second notice", async () => {
  const f = deps(ctxOf({ retry: { oldestPendingAt: new Date(NOW.getTime() - 11 * 60_000), delayNoticeSent: true } }), down);
  await run(f.d);
  assert.deepEqual(f.log.alerts, ["batch_processing_failed"]);
  assert.deepEqual(f.log.handoffs, [{ source: "failed_answers" }]);
  assert.deepEqual(f.log.conv, [{ handling: "human_active" }]);    // the assistant stays silent from now on
  assert.equal(f.log.owner.length, 1); assert.equal(f.log.owner[0].type, "needs_human");
  assert.deepEqual(f.log.sent, []);                                 // the notice already went out earlier
  assert.deepEqual(f.log.deferred, []);                             // no more automatic retries: the owner can press Resume, which re-queues it
});

test("every retry over and the customer never heard anything: they get the delay notice once, then the handoff", async () => {
  const f = deps(ctxOf({ retry: { oldestPendingAt: new Date(NOW.getTime() - 11 * 60_000), delayNoticeSent: false } }), down);
  await run(f.d);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]); assert.deepEqual(f.log.handoffs, [{ source: "failed_answers" }]);
});

test("a refused key is not a temporary outage: no delay, no retry loop, the existing key handling runs", async () => {
  const byok = ctxOf(); byok.client.ai = { mode: "byok", apiKey: "k", keyStatus: "valid" };
  const f = deps(byok, async () => { throw Object.assign(new Error("403 API key not valid"), { status: 403 }); });
  await run(f.d);
  assert.deepEqual(f.log.deferred, []); assert.equal(f.log.keyReports, 1);
  assert.deepEqual(f.log.sent, [CAP_REPLY]); // "our team will get back to you", not the delay line
});

test("8. a person took over meanwhile: the retry sends nothing and releases the queue", async () => {
  const f = deps(ctxOf({}, { handling: "human_active" }), down);
  await run(f.d);
  assert.deepEqual(f.log.sent, []); assert.deepEqual(f.log.deferred, []); assert.equal(f.log.completed.length, 1);
});

test("9. the 24-hour window has closed: no free-form message and no more waiting; the owner is told through the handoff", async () => {
  const f = deps(ctxOf({}, { lastCustomerMessageAt: new Date(NOW.getTime() - WINDOW_MS - 1000) }), down);
  await run(f.d);
  assert.deepEqual(f.log.sent, []);
  assert.deepEqual(f.log.saved, []);                                  // nothing is even attempted outside the window
  assert.deepEqual(f.log.deferred, []); assert.deepEqual(f.log.handoffs, [{ source: "failed_answers" }]);
});

test("a subscription that is not active is never retried or answered", async () => {
  const c = ctxOf(); c.client.billing = { allowed: false, reason: "unpaid", banner: "none", graceEndsAt: null, paidThrough: null } as BatchContext["client"]["billing"];
  const f = deps(c, down);
  await run(f.d);
  assert.deepEqual(f.log.sent, []); assert.deepEqual(f.log.deferred, []); assert.equal(f.log.completed.length, 1);
});
