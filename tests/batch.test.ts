import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAP_REPLY, cleanContactDetails, CUSTOMER_MESSAGES_PER_HOUR, FALLBACK_REPLY, NON_TEXT_REPLY,
  processConversationBatch, runBatches, sweepDueBatches,
  type BatchContext, type BatchDeps, type SaveReply,
} from "../lib/batch";
import { InvalidModelOutputError } from "../lib/ai/generate-reply";
import type { ReplyResult } from "../lib/ai/schema";
import type { OwnerEvent } from "../lib/email/templates";
import { WINDOW_MS } from "../lib/whatsapp/window";

const NOW = new Date("2026-01-02T12:00:00Z");

const reply = (over: Partial<ReplyResult> = {}): ReplyResult => ({
  reply: "We open at 9.", intent: "question", answered: true,
  contact: { name: null, email: null }, ...over,
});

function makeCtx(over: Partial<BatchContext> = {}, conv: Partial<BatchContext["conversation"]> = {}): BatchContext {
  return {
    client: {
      id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100,
      businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open 9-5",
    },
    conversation: { id: "conv1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: NOW, ...conv },
    contact: { id: "contact1", name: "Asha" },
    phone: "911",
    pending: [{ id: "p1", type: "text", body: "hi" }],
    history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  };
}

function fakeDeps(ctx: BatchContext | null, opts: {
  gen?: () => Promise<{ result: ReplyResult }>; claimResults?: boolean[]; moreAfter?: boolean[]; sendFails?: boolean;
  newLead?: boolean; crmFails?: boolean;
} = {}) {
  const log = { sent: [] as string[], saved: [] as SaveReply[], alerts: [] as string[], conv: [] as object[],
    generated: [] as string[][], completed: [] as string[][], failedUsage: 0, sleeps: 0,
    crm: [] as object[], owner: [] as OwnerEvent[], unanswered: [] as string[] };
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
    applyContactDetails: async (_c, _id, d) => { if (opts.crmFails) throw new Error("crm down"); log.crm.push(d); },
    markLead: async () => opts.newLead ?? false,
    notifyOwner: async (_c, e) => void log.owner.push(e),
    logUnanswered: async (_c, _v, q) => void log.unanswered.push(q),
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

// ---- Stage 3: CRM, leads, owner alerts ----


test("new contact becomes a lead and the owner is emailed once", async () => {
  const f = fakeDeps(makeCtx(), { newLead: true });
  await run(f.deps);
  assert.deepEqual(f.log.owner.map((e) => e.type), ["new_lead"]);
  const again = fakeDeps(makeCtx(), { newLead: false });
  await run(again.deps);
  assert.equal(again.log.owner.length, 0); // markLead is false after the first flip
});

test("model-extracted contact details are cleaned before being stored as suggestions", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ contact: { name: " Ravi Kumar ", email: "ravi@example.com" } }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.crm, [{ name: "Ravi Kumar", email: "ravi@example.com" }]);
});

test("junk contact details are dropped and never stored", () => {
  assert.deepEqual(cleanContactDetails({ name: "n/a", email: "not-an-email" }), { name: null, email: null });
  assert.deepEqual(cleanContactDetails({ name: "A", email: "" }), { name: null, email: null });
  assert.deepEqual(cleanContactDetails({ name: null, email: "x@y.co" }), { name: null, email: "x@y.co" });
});

test("no contact details from the model: nothing is written to the CRM", async () => {
  const f = fakeDeps(makeCtx());
  await run(f.deps);
  assert.equal(f.log.crm.length, 0);
});

test("booking without a link: a person takes over, the owner is told why, nothing is saved or logged as unanswered", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "booking", answered: false }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.owner.map((e) => e.type === "needs_human" && e.reason), ["booking_without_link"]);
  assert.equal(f.log.unanswered.length, 0);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0, handling: "human_active" });
});

test("booking with a link: the link is shared by the model and the bot stays on", async () => {
  const ctx = makeCtx();
  ctx.client.bookingLink = "https://cal.example/x";
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ intent: "booking", reply: "Pick a time: https://cal.example/x" }) }) });
  await run(f.deps);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0 });
});

test("handoff emails the owner with the right reason", async () => {
  const asked = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(asked.deps);
  assert.deepEqual(asked.log.owner.map((e) => e.type === "needs_human" && e.reason), ["customer_request_or_upset"]);

  const failed = fakeDeps(makeCtx({}, { failedAnswerCount: 1 }), { gen: async () => ({ result: reply({ answered: false }) }) });
  await run(failed.deps);
  assert.deepEqual(failed.log.owner.map((e) => e.type === "needs_human" && e.reason), ["failed_answers"]);
});

test("a bookkeeping failure after the reply is alerted but does NOT send the fallback", async () => {
  const f = fakeDeps(makeCtx(), {
    crmFails: true,
    gen: async () => ({ result: reply({ contact: { name: "Ravi Kumar", email: null } }) }),
  });
  await run(f.deps);
  assert.deepEqual(f.log.sent, ["We open at 9."]); // only the real reply
  assert.deepEqual(f.log.alerts, ["post_reply_step_failed"]);
  assert.equal(f.log.completed.length, 1);
});

test("unanswered questions are logged; answered ones and handoffs are not", async () => {
  const f = fakeDeps(makeCtx({ pending: [{ id: "p1", type: "text", body: "do you do implants" }, { id: "p2", type: "text", body: "and the price?" }] }),
    { gen: async () => ({ result: reply({ answered: false }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.unanswered, ["do you do implants / and the price?"]);

  const ok = fakeDeps(makeCtx());
  await run(ok.deps);
  assert.equal(ok.log.unanswered.length, 0);

  const human = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ answered: false, intent: "human_needed" }) }) });
  await run(human.deps);
  assert.equal(human.log.unanswered.length, 0);
});
