import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAP_REPLY, CUSTOMER_MESSAGES_PER_HOUR, FALLBACK_REPLY, NON_TEXT_REPLY,
  processConversationBatch, runBatches, sweepDueBatches,
  type BatchContext, type BatchDeps, type SaveReply,
} from "../lib/batch";
import { InvalidModelOutputError } from "../lib/ai/generate-reply";
import type { ReplyResult } from "../lib/ai/schema";
import { WINDOW_MS } from "../lib/whatsapp/window";

const NOW = new Date("2026-01-02T12:00:00Z");

const reply = (over: Partial<ReplyResult> = {}): ReplyResult => ({
  reply: "We open at 9.", intent: "question", answered: true,
  contact: { name: null, email: null }, booking: { service: null, preferred_time: null, name: null }, ...over,
});

function makeCtx(over: Partial<BatchContext> = {}, conv: Partial<BatchContext["conversation"]> = {}): BatchContext {
  return {
    client: {
      id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100,
      businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open 9-5",
    },
    conversation: { id: "conv1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: NOW, ...conv },
    phone: "911",
    pending: [{ id: "p1", type: "text", body: "hi" }],
    history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  };
}

function fakeDeps(ctx: BatchContext | null, opts: {
  gen?: () => Promise<{ result: ReplyResult }>; claimResults?: boolean[]; moreAfter?: boolean[]; sendFails?: boolean;
} = {}) {
  const log = { sent: [] as string[], saved: [] as SaveReply[], alerts: [] as string[], conv: [] as object[],
    generated: [] as string[][], completed: [] as string[][], failedUsage: 0, sleeps: 0 };
  const claims = [...(opts.claimResults ?? [true])];
  const more = [...(opts.moreAfter ?? [false])];
  const deps: BatchDeps = {
    claim: async () => claims.length ? claims.shift()! : false,
    load: async () => ctx,
    complete: async (_c, ids) => { log.completed.push(ids); return more.length ? more.shift()! : false; },
    generate: async (_ctx, lines) => {
      log.generated.push(lines);
      const g = await (opts.gen ?? (async () => ({ result: reply() })))();
      return { result: g.result, usage: { inputTokens: 10, outputTokens: 5 }, provider: "gemini", model: "m" };
    },
    sendText: async (_c, body) => {
      if (opts.sendFails) { opts.sendFails = false; throw new Error("graph down"); }
      log.sent.push(body); return { waMessageId: `out.${log.sent.length}` };
    },
    saveReply: async (r) => void log.saved.push(r),
    updateConversation: async (_c, _v, patch) => void log.conv.push(patch),
    recordFailedUsage: async () => void log.failedUsage++,
    raiseAlert: async (_c, kind) => void log.alerts.push(kind),
    findDueBatches: async () => ["convA", "convB"],
    sleep: async () => void log.sleeps++,
  };
  return { deps, log };
}
const run = (deps: BatchDeps) => processConversationBatch("conv1", deps, () => NOW);

test("batching: several pending messages produce ONE model call and ONE reply", async () => {
  const ctx = makeCtx({ pending: [
    { id: "p1", type: "text", body: "hi" }, { id: "p2", type: "text", body: "do you open sat" }, { id: "p3", type: "text", body: "?" },
  ] });
  const f = fakeDeps(ctx);
  await run(f.deps);
  assert.deepEqual(f.log.generated, [["hi", "do you open sat", "?"]]);
  assert.equal(f.log.sent.length, 1);
  assert.deepEqual(f.log.completed, [["p1", "p2", "p3"]]);
  assert.equal(f.log.saved[0].usage?.inputTokens, 10); // tokens tracked per message
});

test("claim lost (another worker owns the batch): nothing happens", async () => {
  const f = fakeDeps(makeCtx(), { claimResults: [false] });
  await run(f.deps);
  assert.equal(f.log.sent.length, 0);
  assert.equal(f.log.completed.length, 0);
});

test("messages arriving during processing trigger another loop", async () => {
  const f = fakeDeps(makeCtx(), { claimResults: [true, true], moreAfter: [true, false] });
  await run(f.deps);
  assert.equal(f.log.sent.length, 2);
  assert.equal(f.log.sleeps, 1);
});

test("human_active: bot stays silent but the batch is released", async () => {
  const f = fakeDeps(makeCtx({}, { handling: "human_active" }));
  await run(f.deps);
  assert.equal(f.log.sent.length, 0);
  assert.equal(f.log.generated.length, 0);
  assert.equal(f.log.completed.length, 1);
});

test("24h window: a send outside the window is blocked and recorded, not sent", async () => {
  const f = fakeDeps(makeCtx({}, { lastCustomerMessageAt: new Date(NOW.getTime() - WINDOW_MS - 1) }));
  await run(f.deps);
  assert.equal(f.log.sent.length, 0);
  assert.equal(f.log.saved[0].status, "blocked");
  assert.equal(f.log.saved[0].error, "outside_24h_window");
});

test("only media: asks for text without calling the model", async () => {
  const f = fakeDeps(makeCtx({ pending: [{ id: "p1", type: "audio", body: null }] }));
  await run(f.deps);
  assert.deepEqual(f.log.sent, [NON_TEXT_REPLY]);
  assert.equal(f.log.generated.length, 0);
});

test("text plus media: model is called with the text", async () => {
  const f = fakeDeps(makeCtx({ pending: [{ id: "p1", type: "text", body: "see pic" }, { id: "p2", type: "image", body: null }] }));
  await run(f.deps);
  assert.deepEqual(f.log.generated, [["see pic"]]);
});

test("intent human_needed hands the conversation to a person", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(f.deps);
  assert.equal(f.log.sent.length, 1); // customer still gets the polite reply
  assert.deepEqual(f.log.conv[0], { failedAnswerCount: 0, handling: "human_active" });
});

test("two failed answers in a row trigger handoff; one does not", async () => {
  const unanswered = async () => ({ result: reply({ answered: false }) });
  const first = fakeDeps(makeCtx({}, { failedAnswerCount: 0 }), { gen: unanswered });
  await run(first.deps);
  assert.deepEqual(first.log.conv[0], { failedAnswerCount: 1 });
  const second = fakeDeps(makeCtx({}, { failedAnswerCount: 1 }), { gen: unanswered });
  await run(second.deps);
  assert.deepEqual(second.log.conv[0], { failedAnswerCount: 2, handling: "human_active" });
});

test("an answered question resets the failed-answer counter", async () => {
  const f = fakeDeps(makeCtx({}, { failedAnswerCount: 1 }));
  await run(f.deps);
  assert.deepEqual(f.log.conv[0], { failedAnswerCount: 0 });
});

test("monthly cap: no model call, canned reply, admin alerted", async () => {
  const f = fakeDeps(makeCtx({ repliesThisMonth: 100 }));
  await run(f.deps);
  assert.equal(f.log.generated.length, 0);
  assert.deepEqual(f.log.sent, [CAP_REPLY]);
  assert.deepEqual(f.log.alerts, ["monthly_cap_reached"]);
});

test("per-customer rate limit: no model call and no reply", async () => {
  const f = fakeDeps(makeCtx({ recentInboundCount: CUSTOMER_MESSAGES_PER_HOUR + 1 }));
  await run(f.deps);
  assert.equal(f.log.generated.length, 0);
  assert.equal(f.log.sent.length, 0);
  assert.equal(f.log.completed.length, 1);
});

test("model failure: alert, fallback to the customer, tokens still recorded, batch released", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => { throw new InvalidModelOutputError("bad", { inputTokens: 3, outputTokens: 2 }, "gemini", "m"); } });
  await run(f.deps);
  assert.deepEqual(f.log.alerts, ["batch_processing_failed"]);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]);
  assert.equal(f.log.failedUsage, 1);
  assert.equal(f.log.completed.length, 1);
});

test("send failure: alert and fallback attempt", async () => {
  const f = fakeDeps(makeCtx(), { sendFails: true });
  await run(f.deps);
  assert.deepEqual(f.log.alerts, ["batch_processing_failed"]);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]);
});

test("sweep processes every overdue batch; runBatches waits then sweeps", async () => {
  const f = fakeDeps(makeCtx(), { claimResults: [true, true, true, true] });
  assert.equal(await sweepDueBatches(f.deps), 2);
  const g = fakeDeps(makeCtx(), { claimResults: [true, true, true] });
  await runBatches(["conv1"], g.deps);
  assert.ok(g.log.sleeps >= 1);
});
