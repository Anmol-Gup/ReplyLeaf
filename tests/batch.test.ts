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
import { DEFAULT_WORKFLOW_SETTINGS } from "../lib/workflow-settings";
import { ACTION_FAILED_REPLY, OPEN_REQUEST_REPLY, REJECTED_SUBMIT_REPLY, type WorkflowState } from "../lib/workflow";
import { baseReply } from "./fixtures";

const NOW = new Date("2026-01-02T12:00:00Z");

const reply = (over: Partial<ReplyResult> = {}): ReplyResult => baseReply(over);

function makeCtx(over: Partial<BatchContext> = {}, conv: Partial<BatchContext["conversation"]> = {}): BatchContext {
  return {
    client: {
      id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100,
      businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open 9-5", workflow: DEFAULT_WORKFLOW_SETTINGS,
    },
    conversation: { id: "conv1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: NOW, workflowState: null, ...conv },
    openAppointment: null,
    contact: { id: "contact1", name: "Asha" },
    phone: "911",
    pending: [{ id: "p1", type: "text", body: "hi" }],
    history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  };
}

function fakeDeps(ctx: BatchContext | null, opts: {
  gen?: () => Promise<{ result: ReplyResult }>; claimResults?: boolean[]; moreAfter?: boolean[]; sendFails?: boolean;
  newLead?: boolean; crmFails?: boolean; handoffCreated?: boolean; handoffFails?: boolean; apptCreated?: boolean; apptFails?: boolean; leadCreated?: boolean;
} = {}) {
  const log = { sent: [] as string[], saved: [] as SaveReply[], alerts: [] as string[], conv: [] as object[],
    generated: [] as string[][], completed: [] as string[][], failedUsage: 0, sleeps: 0,
    crm: [] as object[], owner: [] as OwnerEvent[], unanswered: [] as string[], handoffs: [] as { source: string; reason: string; summary: string }[], appts: [] as object[], leads: [] as object[] };
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
    saveAppointment: async (_c, _ctx, a) => { if (opts.apptFails) throw new Error("db down"); log.appts.push(a); return { created: opts.apptCreated ?? true }; },
    saveLead: async (_c, _ctx, l) => { log.leads.push(l); return { created: opts.leadCreated ?? true }; },
    createHandoff: async (_c, _v, input) => { if (opts.handoffFails) throw new Error("db down"); log.handoffs.push(input); return { created: opts.handoffCreated ?? true }; },
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

test("appointments switched off and no link: a person takes over, the owner is told why, nothing is logged as unanswered", async () => {
  const ctx = makeCtx();
  ctx.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, appointments: { ...DEFAULT_WORKFLOW_SETTINGS.appointments, enabled: false } };
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ intent: "appointment_request", answered: false }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.owner.map((e) => e.type === "needs_human" && e.reason), ["booking_without_link"]);
  assert.equal(f.log.unanswered.length, 0);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0, handling: "human_active" });
});

test("booking with a link: the link is shared by the model and the bot stays on", async () => {
  const ctx = makeCtx();
  ctx.client.bookingLink = "https://cal.example/x";
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ intent: "appointment_request", reply: "Pick a time: https://cal.example/x" }) }) });
  await run(f.deps);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0 });
});

test("with a link, an appointment submit from the model is refused: nothing saved, the customer is asked to confirm", async () => {
  const ctx = makeCtx({}, { workflowState: { flow: "appointment", stage: "awaiting_confirmation", updatedAt: NOW.toISOString() } });
  ctx.client.bookingLink = "https://cal.example/x";
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ reply: "Submitted!", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
  assert.deepEqual(f.log.sent, [REJECTED_SUBMIT_REPLY]);
});

test("handoff emails the owner with the right reason", async () => {
  const asked = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(asked.deps);
  assert.deepEqual(asked.log.owner.map((e) => e.type === "needs_human" && e.reason), ["customer_request"]);

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

// ---- Human handoff ----
test("handoff creates a record with a reason and the model's summary, and emails the owner once", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "human_needed", summary: "Wants a refund for order 123." }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.handoffs, [{ source: "customer_request", reason: "The customer asked for a person, is upset, or needs something sensitive", summary: "Wants a refund for order 123." }]);
  const mail = f.log.owner.find((e) => e.type === "needs_human");
  assert.ok(mail && mail.type === "needs_human" && mail.summary === "Wants a refund for order 123.");
});

test("a retried webhook (open handoff already exists) does not email the owner again", async () => {
  const f = fakeDeps(makeCtx(), { handoffCreated: false, gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(f.deps);
  assert.equal(f.log.handoffs.length, 1);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0);
});

test("no model summary: the record falls back to the customer's last message", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "human_needed", summary: null }) }) });
  await run(f.deps);
  assert.match(f.log.handoffs[0].summary, /^Last message: /);
});

test("the assistant is silenced even if saving the handoff record fails", async () => {
  const f = fakeDeps(makeCtx(), { handoffFails: true, gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.conv[0], { failedAnswerCount: 0, handling: "human_active" });
  assert.ok(f.log.alerts.includes("post_reply_step_failed")); // the admin is told, the customer still got the reply
  assert.equal(f.log.sent.length, 1);
});

test("a normal answer creates no handoff", async () => {
  const f = fakeDeps(makeCtx());
  await run(f.deps);
  assert.equal(f.log.handoffs.length, 0);
});

// ---- Appointment requests ----
const APPT_FIELDS = { purpose: "dental check-up", preferred_date: "2026-01-09", preferred_time: "10am", timezone: null, appointment_type: null, notes: null, customer_name: "Asha K" } as const;
const APPT_SUBMIT = {
  intent: "appointment_request" as const,
  workflow: { flow: "appointment" as const, stage: null },
  appointment: { ...APPT_FIELDS },
  action: { type: "submit_appointment" as const, customer_confirmed: true },
};
const awaiting = (flow: "appointment" | "enquiry"): WorkflowState => ({ flow, stage: "awaiting_confirmation", updatedAt: NOW.toISOString() });

test("collecting an appointment: state is stored, nothing is saved, no email yet", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({
    intent: "appointment_request", reply: "What day suits you?",
    workflow: { flow: "appointment", stage: "collecting" }, appointment: { ...APPT_FIELDS, preferred_date: null, preferred_time: null },
  }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 0);
  const patch = f.log.conv.at(-1) as { workflowState?: WorkflowState };
  assert.equal(patch.workflowState?.flow, "appointment");
  assert.equal(patch.workflowState?.stage, "collecting");
});

test("summary shown: stage becomes awaiting_confirmation (and nothing is saved yet)", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({
    intent: "appointment_request", reply: "So: check-up on 9 Jan at 10am. Correct?",
    workflow: { flow: "appointment", stage: "awaiting_confirmation" }, appointment: { ...APPT_FIELDS },
  }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
  assert.equal((f.log.conv.at(-1) as { workflowState?: WorkflowState }).workflowState?.stage, "awaiting_confirmation");
});

test("confirmed after a summary: saved as pending data, owner emailed, customer told it awaits confirmation, state cleared", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { gen: async () => ({ result: reply({ reply: "Thanks! Your appointment request has been submitted.", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 1);
  assert.deepEqual(f.log.sent, ["Thanks! Your appointment request has been submitted."]);
  const mail = f.log.owner.find((e) => e.type === "appointment_request");
  assert.ok(mail && mail.type === "appointment_request" && mail.purpose === "dental check-up" && mail.preferredDate === "2026-01-09");
  assert.equal((f.log.conv.at(-1) as { workflowState?: WorkflowState | null }).workflowState, null);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0); // an appointment is not a handoff
});

test("a submit with no summary shown first is refused: nothing saved, no email, the customer is asked to confirm", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ reply: "Submitted!", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 0);
  assert.deepEqual(f.log.sent, [REJECTED_SUBMIT_REPLY]); // never "your request has been submitted" when it was not
});

test("a stale confirmation prompt (older than 48h) cannot be used to submit", async () => {
  const old = { flow: "appointment" as const, stage: "awaiting_confirmation" as const, updatedAt: new Date(NOW.getTime() - 49 * 3600_000).toISOString() };
  const f = fakeDeps(makeCtx({}, { workflowState: old }), { gen: async () => ({ result: reply(APPT_SUBMIT) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
});

test("customer_confirmed=false, or missing details, or an invalid/past date: nothing saved", async () => {
  const cases = [
    { ...APPT_SUBMIT, action: { type: "submit_appointment" as const, customer_confirmed: false } },
    { ...APPT_SUBMIT, appointment: { ...APPT_FIELDS, purpose: null } },
    { ...APPT_SUBMIT, appointment: { ...APPT_FIELDS, preferred_date: "2025-01-01", preferred_time: null } },
    { ...APPT_SUBMIT, appointment: { ...APPT_FIELDS, preferred_date: "tomorrow", preferred_time: null } },
  ];
  for (const c of cases) {
    const ctx = makeCtx({}, { workflowState: awaiting("appointment") });
    ctx.contact.name = null;
    const f = fakeDeps(ctx, { gen: async () => ({ result: reply(c.appointment.customer_name === null ? c : { ...c, appointment: { ...c.appointment } }) }) });
    await run(f.deps);
    assert.equal(f.log.appts.length, 0, JSON.stringify(c.appointment));
  }
});

test("a retried webhook (request already open): no second email and the customer still gets a reply", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { apptCreated: false, gen: async () => ({ result: reply(APPT_SUBMIT) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 1);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 0);
  assert.equal(f.log.sent.length, 1);
});

test("a second appointment while one is open is handed to a person with its details, never silently dropped or called 'submitted'", async () => {
  const ctx = makeCtx({ openAppointment: { status: "pending", rescheduleNote: null } }, { workflowState: awaiting("appointment") });
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ reply: "Thanks! Submitted.", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 0);
  assert.deepEqual(f.log.sent, [OPEN_REQUEST_REPLY]);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 0);
  assert.match(f.log.handoffs[0].summary, /another appointment while one is still open: dental check-up, 2026-01-09 10am/);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0, handling: "human_active", workflowState: null });
});

test("saving fails: the customer is NOT told it was submitted, the admin is alerted and a person takes over", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { apptFails: true, gen: async () => ({ result: reply({ reply: "Thanks! Submitted.", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.sent, [ACTION_FAILED_REPLY]);
  assert.ok(f.log.alerts.includes("workflow_save_failed"));
  assert.deepEqual(f.log.handoffs.map((h) => h.source), ["action_failed"]);
  assert.deepEqual(f.log.conv.at(-1), { failedAnswerCount: 0, handling: "human_active", workflowState: null });
});

test("handoff switched off in settings: a customer asking for a person does not pause the assistant", async () => {
  const ctx = makeCtx();
  ctx.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, handoff: { ...DEFAULT_WORKFLOW_SETTINGS.handoff, enabled: false } };
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ intent: "human_needed" }) }) });
  await run(f.deps);
  assert.equal(f.log.handoffs.length, 0);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0);
  assert.equal(f.log.conv.at(-1) && "handling" in (f.log.conv.at(-1) as object), false);
});

// ---- Project enquiries ----
const LEAD = { project_type: "e-commerce website", description: "Online store for handmade candles with card payments", budget: "$3-5k", timeline: "6 weeks", requirements: [{ key: "platform", value: "Shopify" }] };
const LEAD_SUBMIT = {
  intent: "project_enquiry" as const, summary: "Wants a Shopify candle store in 6 weeks.",
  workflow: { flow: "enquiry" as const, stage: null }, lead: LEAD,
  action: { type: "submit_lead" as const, customer_confirmed: true },
};

test("confirmed enquiry: lead saved as qualified (budget + timeline known), owner emailed once", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ reply: "Thanks, the team has your enquiry.", ...LEAD_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 1);
  assert.equal((f.log.leads[0] as { status: string }).status, "qualified");
  const mail = f.log.owner.find((e) => e.type === "lead_created");
  assert.ok(mail && mail.type === "lead_created" && mail.projectType === "e-commerce website" && mail.status === "qualified");
});

test("enquiry without budget or timeline is saved as NEW, never qualified", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ ...LEAD_SUBMIT, lead: { ...LEAD, budget: null } }) }) });
  await run(f.deps);
  assert.equal((f.log.leads[0] as { status: string }).status, "new");
});

test("enquiry submit without a prior summary, or with a missing description, saves nothing", async () => {
  const noSummary = fakeDeps(makeCtx(), { gen: async () => ({ result: reply(LEAD_SUBMIT) }) });
  await run(noSummary.deps);
  assert.equal(noSummary.log.leads.length, 0);
  const thin = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ ...LEAD_SUBMIT, lead: { ...LEAD, description: "site" } }) }) });
  await run(thin.deps);
  assert.equal(thin.log.leads.length, 0);
});

test("enquiries switched off: a model submit is refused", async () => {
  const ctx = makeCtx({}, { workflowState: awaiting("enquiry") });
  ctx.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, enquiries: { ...DEFAULT_WORKFLOW_SETTINGS.enquiries, enabled: false } };
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply(LEAD_SUBMIT) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 0);
});

test("duplicate enquiry delivery: no second email", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { leadCreated: false, gen: async () => ({ result: reply(LEAD_SUBMIT) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 1);
  assert.equal(f.log.owner.filter((e) => e.type === "lead_created").length, 0);
});
