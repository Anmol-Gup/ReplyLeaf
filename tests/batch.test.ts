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
import { ACTION_FAILED_REPLY, ALREADY_SUBMITTED_REPLY, REJECTED_SUBMIT_REPLY, type WorkflowState } from "../lib/workflow";
import { baseReply } from "./fixtures";

const NOW = new Date("2026-01-02T12:00:00Z");

const reply = (over: Partial<ReplyResult> = {}): ReplyResult => baseReply(over);

function makeCtx(over: Partial<BatchContext> = {}, conv: Partial<BatchContext["conversation"]> = {}): BatchContext {
  return {
    client: {
      id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100,
      businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open 9-5", workflow: DEFAULT_WORKFLOW_SETTINGS,
      ai: { mode: "platform", apiKey: null, keyStatus: "none" },
      billing: { allowed: true, reason: "active", banner: "none", graceEndsAt: null, paidThrough: null },
    },
    conversation: { id: "conv1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: NOW, workflowState: null, ...conv },
    open: { appointments: [], tickets: 0, leads: 0 },
    contact: { id: "contact1", name: "Asha" },
    phone: "911",
    pending: [{ id: "p1", type: "text", body: "hi" }],
    history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  };
}

function fakeDeps(ctx: BatchContext | null, opts: {
  gen?: () => Promise<{ result: ReplyResult }>; claimResults?: boolean[]; moreAfter?: boolean[]; sendFails?: boolean;
  newLead?: boolean; crmFails?: boolean; handoffCreated?: boolean; handoffFails?: boolean; apptCreated?: boolean; apptFails?: boolean; leadCreated?: boolean; ticketCreated?: boolean; genThrows?: unknown;
} = {}) {
  const log = { sent: [] as string[], saved: [] as SaveReply[], alerts: [] as string[], conv: [] as object[],
    generated: [] as string[][], completed: [] as string[][], failedUsage: 0, sleeps: 0,
    crm: [] as object[], owner: [] as OwnerEvent[], unanswered: [] as string[], handoffs: [] as { source: string; reason: string; summary: string }[], appts: [] as object[], leads: [] as object[], tickets: [] as object[], keyReports: [] as { problem: string; markInvalid?: boolean }[], sendProblems: [] as string[], notifyEmails: [] as string[] };
  const claims = [...(opts.claimResults ?? [true])];
  const more = [...(opts.moreAfter ?? [false])];
  const deps: BatchDeps = {
    claim: async () => claims.length ? claims.shift()! : false,
    load: async () => ctx,
    complete: async (_c, ids) => { log.completed.push(ids); return more.length ? more.shift()! : false; },
    generate: async (_ctx, lines) => {
      log.generated.push(lines);
      if (opts.genThrows) throw opts.genThrows;
      const g = await (opts.gen ?? (async () => ({ result: reply() })))();
      return { result: g.result, usage: { inputTokens: 10, outputTokens: 5 }, provider: "gemini", model: "m" };
    },
    sendText: async (_c, body) => {
      if (opts.sendFails) { opts.sendFails = false; throw new Error("graph down"); }
      log.sent.push(body); return { waMessageId: `out.${log.sent.length}` };
    },
    saveReply: async (r) => void log.saved.push(r),
    reportSendProblem: async (_c, problem) => void log.sendProblems.push(problem),
    saveNotifyEmail: async (_c, _id, email) => void log.notifyEmails.push(email),
    saveAppointment: async (_c, _ctx, a) => { if (opts.apptFails) throw new Error("db down"); log.appts.push(a); return { created: opts.apptCreated ?? true }; },
    reportAiKeyProblem: async (_c, problem, o) => void log.keyReports.push({ problem, markInvalid: o?.markInvalid }),
    saveTicket: async (_c, _ctx, t) => { log.tickets.push(t); return { created: opts.ticketCreated ?? true }; },
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
const awaiting = (flow: "appointment" | "enquiry" | "issue"): WorkflowState => ({ flow, stage: "awaiting_confirmation", updatedAt: NOW.toISOString() });

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

// ---- Support tickets ----
const TICKET = { subject: "Order not delivered", description: "Order 4521 placed 10 days ago has not arrived. Wants a replacement.", category: "delivery", reference_info: "4521", priority: "normal" as const };
const TICKET_SUBMIT = {
  intent: "support_issue" as const, summary: "Order 4521 not delivered; wants a replacement.",
  workflow: { flow: "issue" as const, stage: null }, ticket: TICKET,
  action: { type: "submit_ticket" as const, customer_confirmed: true },
};

test("confirmed support problem: ticket saved, owner emailed once, the customer is told the team logged it", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { gen: async () => ({ result: reply({ reply: "I've logged this and the team will look into it.", ...TICKET_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.tickets.length, 1);
  const mail = f.log.owner.find((e) => e.type === "ticket_created");
  assert.ok(mail && mail.type === "ticket_created" && mail.subject === "Order not delivered" && mail.referenceInfo === "4521");
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0); // a ticket is not a handoff
});

test("a ticket submit without a prior summary, or with a thin description, or with support off, saves nothing", async () => {
  const noSummary = fakeDeps(makeCtx(), { gen: async () => ({ result: reply(TICKET_SUBMIT) }) });
  await run(noSummary.deps);
  assert.equal(noSummary.log.tickets.length, 0);
  const thin = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { gen: async () => ({ result: reply({ ...TICKET_SUBMIT, ticket: { ...TICKET, description: "bad" } }) }) });
  await run(thin.deps);
  assert.equal(thin.log.tickets.length, 0);
  const off = makeCtx({}, { workflowState: awaiting("issue") });
  off.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, support: { ...DEFAULT_WORKFLOW_SETTINGS.support, enabled: false } };
  const disabled = fakeDeps(off, { gen: async () => ({ result: reply(TICKET_SUBMIT) }) });
  await run(disabled.deps);
  assert.equal(disabled.log.tickets.length, 0);
});

test("the same open ticket again: told it is already with the team, no second email", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { ticketCreated: false, gen: async () => ({ result: reply(TICKET_SUBMIT) }) });
  await run(f.deps);
  assert.deepEqual(f.log.sent, [ALREADY_SUBMITTED_REPLY]);
  assert.equal(f.log.owner.filter((e) => e.type === "ticket_created").length, 0);
});

test("high priority is carried through to the ticket email", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { gen: async () => ({ result: reply({ ...TICKET_SUBMIT, ticket: { ...TICKET, priority: "high" } }) }) });
  await run(f.deps);
  const mail = f.log.owner.find((e) => e.type === "ticket_created");
  assert.ok(mail && mail.type === "ticket_created" && mail.priority === "high");
});

test("a second, DIFFERENT appointment while one is open is collected normally (several open requests are allowed)", async () => {
  const ctx = makeCtx({ open: { appointments: [{ status: "pending", rescheduleNote: null }], tickets: 0, leads: 0 } }, { workflowState: awaiting("appointment") });
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ reply: "Thanks! Your appointment request has been submitted.", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 1);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 1);
  assert.equal(f.log.owner.filter((e) => e.type === "needs_human").length, 0); // no handoff: it is not a problem
});

test("the SAME open request again: the customer is told it is already with the team, not 'submitted', and nobody is emailed twice", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { apptCreated: false, gen: async () => ({ result: reply({ reply: "Thanks! Submitted.", ...APPT_SUBMIT }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.sent, [ALREADY_SUBMITTED_REPLY]);
  assert.equal(f.log.owner.filter((e) => e.type === "appointment_request").length, 0);
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

test("confirmed enquiry: lead saved as NEW even with budget and timeline known (only the owner qualifies a lead), owner emailed once", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ reply: "Thanks, the team has your enquiry.", ...LEAD_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 1);
  assert.equal((f.log.leads[0] as { status: string }).status, "new");
  const mail = f.log.owner.find((e) => e.type === "lead_created");
  assert.ok(mail && mail.type === "lead_created" && mail.projectType === "e-commerce website" && mail.status === "new");
});

test("enquiry without budget or timeline is saved as NEW too", async () => {
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

// ---- Bring your own AI key ----
const byok = (over: Partial<BatchContext["client"]["ai"]> = {}) => {
  const ctx = makeCtx();
  ctx.client.ai = { mode: "byok", apiKey: "sk-test-own-key-1234567890", keyStatus: "valid", ...over };
  return ctx;
};

test("BYOK with a working key: the AI is used and the monthly reply cap does NOT apply (the business pays its provider)", async () => {
  const ctx = byok();
  ctx.repliesThisMonth = 100000;
  const f = fakeDeps(ctx);
  await run(f.deps);
  assert.equal(f.log.generated.length, 1);
  assert.deepEqual(f.log.sent, ["We open at 9."]);
});

test("platform mode: the monthly cap still applies (the platform pays)", async () => {
  const ctx = makeCtx();
  ctx.repliesThisMonth = 100;
  const f = fakeDeps(ctx);
  await run(f.deps);
  assert.equal(f.log.generated.length, 0);
  assert.deepEqual(f.log.sent, [CAP_REPLY]);
});

test("BYOK with no key: no AI call at all, the customer is told the team will reply, the chat goes to Human handoff, the owner is told", async () => {
  const f = fakeDeps(byok({ apiKey: null, keyStatus: "none" }));
  await run(f.deps);
  assert.equal(f.log.generated.length, 0);                                   // the platform key is never borrowed
  assert.deepEqual(f.log.sent, [CAP_REPLY]);
  assert.deepEqual(f.log.keyReports, [{ problem: "missing", markInvalid: false }]);
  assert.deepEqual(f.log.handoffs.map((h) => h.source), ["ai_unavailable"]);
  assert.deepEqual(f.log.conv.at(-1), { handling: "human_active" });
});

test("BYOK with a key already known to be refused: same, reported as invalid", async () => {
  const f = fakeDeps(byok({ keyStatus: "invalid" }));
  await run(f.deps);
  assert.equal(f.log.generated.length, 0);
  assert.equal(f.log.keyReports[0].problem, "invalid");
});

test("BYOK, the provider refuses the key mid-conversation: the key is marked invalid, the customer is NOT told 'something went wrong'", async () => {
  const f = fakeDeps(byok(), { genThrows: Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 }) });
  await run(f.deps);
  assert.deepEqual(f.log.sent, [CAP_REPLY]);
  assert.deepEqual(f.log.keyReports, [{ problem: "invalid", markInvalid: true }]);
  assert.deepEqual(f.log.handoffs.map((h) => h.source), ["ai_unavailable"]);
});

test("BYOK, a provider outage or quota error is NOT treated as a bad key", async () => {
  const f = fakeDeps(byok(), { genThrows: Object.assign(new Error("RESOURCE_EXHAUSTED: quota exceeded"), { status: 429 }) });
  await run(f.deps);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]);
  assert.equal(f.log.keyReports.length, 0);
  assert.equal(f.log.handoffs.length, 0);
});

test("a platform-mode failure that mentions authentication is not blamed on a business key", async () => {
  const f = fakeDeps(makeCtx(), { genThrows: Object.assign(new Error("401 Unauthorized"), { status: 401 }) });
  await run(f.deps);
  assert.equal(f.log.keyReports.length, 0);
  assert.deepEqual(f.log.sent, [FALLBACK_REPLY]);
});

// ---- Subscription gate (background automation) ----
const unpaid = (reason: "none" | "grace_expired" | "canceled" | "unpaid" = "grace_expired") => {
  const ctx = makeCtx();
  ctx.client.billing = { allowed: false, reason, banner: "inactive", graceEndsAt: null, paidThrough: null };
  return ctx;
};

test("inactive subscription: no AI call, no reply, no workflow, no handoff, no email; the batch is still completed (nothing is replayed later)", async () => {
  for (const reason of ["none", "grace_expired", "canceled", "unpaid"] as const) {
    const f = fakeDeps(unpaid(reason));
    await run(f.deps);
    assert.equal(f.log.generated.length, 0, reason);
    assert.equal(f.log.sent.length, 0, reason);
    assert.equal(f.log.saved.length, 0, reason);
    assert.equal(f.log.handoffs.length, 0, reason);
    assert.equal(f.log.owner.length, 0, reason);
    assert.equal(f.log.appts.length + f.log.leads.length + f.log.tickets.length, 0, reason);
    assert.equal(f.log.completed.length, 1, reason);          // released, so it is not retried forever or answered after payment recovers
  }
});

test("inactive subscription: media-only messages and the monthly-cap path send nothing either", async () => {
  const ctx = unpaid();
  ctx.pending = [{ id: "p1", type: "image", body: null }];
  const f = fakeDeps(ctx);
  await run(f.deps);
  assert.equal(f.log.sent.length, 0);
  const capped = unpaid();
  capped.repliesThisMonth = 100000;
  const g = fakeDeps(capped);
  await run(g.deps);
  assert.equal(g.log.sent.length, 0);
  assert.equal(g.log.alerts.length, 0);
});

test("a subscription inside the grace period still runs everything; once payment recovers the next message is answered normally", async () => {
  const ctx = makeCtx();
  ctx.client.billing = { allowed: true, reason: "grace", banner: "past_due_grace", graceEndsAt: new Date("2026-01-09T00:00:00Z"), paidThrough: null };
  const f = fakeDeps(ctx);
  await run(f.deps);
  assert.deepEqual(f.log.sent, ["We open at 9."]);
  const recovered = fakeDeps(makeCtx());                      // the next batch loads the (now active) subscription
  await run(recovered.deps);
  assert.equal(recovered.log.sent.length, 1);                 // exactly one reply: the messages sent while unpaid are not replayed
});

// ================= intelligent collection: working window, side questions, cancel, ticket reference, isolation =================
import { appointmentWindowIssue, decideAction, nextWorkflowState, parseClockTime, parseWorkflowState } from "../lib/workflow";
import { bookingMode } from "../lib/workflow-settings";
import { buildSystemPrompt, renderProgress, wrapCustomerMessages } from "../lib/ai/prompt";

const stateOf = (f: ReturnType<typeof fakeDeps>) => (f.log.conv.at(-1) as { workflowState?: WorkflowState | null }).workflowState;
const apptTurn = (over: Partial<Record<"purpose" | "preferred_date" | "preferred_time" | "customer_name", string | null>>, stage: "awaiting_confirmation" | null, submit = false) => reply({
  intent: "appointment_request", reply: "So: check-up on the date you gave. Correct?",
  workflow: { flow: "appointment", stage }, appointment: { ...APPT_FIELDS, ...over },
  action: submit ? { type: "submit_appointment", customer_confirmed: true } : { type: "none", customer_confirmed: false },
});

test("clock times: 3pm, 3:30 pm and 15:00 are read; vague or ambiguous ones are not checked", () => {
  assert.equal(parseClockTime("3pm"), 15 * 60);
  assert.equal(parseClockTime("3:30 pm"), 15 * 60 + 30);
  assert.equal(parseClockTime("15:00"), 15 * 60);
  assert.equal(parseClockTime("12am"), 0);
  assert.equal(parseClockTime("12pm"), 12 * 60);
  for (const vague of ["morning", "around 3", "any time", "", null, "25:00"]) assert.equal(parseClockTime(vague as string | null), null);
});

test("appointment window: working days and opening hours (a request, never availability)", () => {
  const a = DEFAULT_WORKFLOW_SETTINGS.appointments; // Mon-Fri 09:00-17:00
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, a, NOW), null);          // Friday, inside hours
  assert.match(appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "", /Saturday/); // non-working day
  assert.match(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "8pm" }, a, NOW) ?? "", /09:00 to 17:00/); // after hours
  assert.match(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "7:30am" }, a, NOW) ?? "", /09:00 to 17:00/); // before hours
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "morning" }, a, NOW), null);        // vague time: not guessed
  assert.equal(appointmentWindowIssue({ preferredDate: null, preferredTime: "10am" }, a, NOW), null);
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: null }, { ...a, workingDays: [] }, NOW), null); // no days set = no restriction
});

test("appointment on a non-working day: the summary is not shown for confirmation, the customer is told why, nothing is saved", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: apptTurn({ preferred_date: "2026-01-10" }, "awaiting_confirmation") }) }); // a Saturday
  await run(f.deps);
  assert.match(f.log.sent[0], /Saturday/);
  assert.equal(f.log.appts.length, 0);
  assert.equal(stateOf(f)?.stage, "collecting");           // never awaiting_confirmation for a day the business cannot take
  assert.ok(stateOf(f)?.missing?.length);
});

test("appointment outside the opening hours: told why, and even a confirmed submit is refused", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: apptTurn({ preferred_time: "9pm" }, "awaiting_confirmation") }) });
  await run(f.deps);
  assert.match(f.log.sent[0], /09:00 to 17:00/);
  const g = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { gen: async () => ({ result: apptTurn({ preferred_time: "9pm" }, null, true) }) });
  await run(g.deps);
  assert.equal(g.log.appts.length, 0);
  assert.match(g.log.sent[0], /09:00 to 17:00/);
  assert.equal(stateOf(g)?.stage, "collecting");
});

test("appointment inside the window still saves as a request after confirmation", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("appointment") }), { gen: async () => ({ result: apptTurn({}, null, true) }) });
  await run(f.deps);
  assert.equal(f.log.appts.length, 1);
});

test("collection progress is stored with the state (what was collected, what is missing) and shown to the model as DATA", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({
    intent: "project_enquiry", reply: "Great! What features do you need?",
    workflow: { flow: "enquiry", stage: "collecting" }, lead: { project_type: "e-commerce website", description: null, budget: null, timeline: null, requirements: [], customer_name: "Ravi" },
  }) }) });
  await run(f.deps);
  const s = stateOf(f)!;
  assert.equal(s.collected?.project, "e-commerce website");
  assert.equal(s.collected?.name, "Ravi");
  assert.ok(s.missing?.includes("description"));
  // survives a database round trip
  assert.deepEqual(parseWorkflowState(JSON.parse(JSON.stringify(s)))?.collected, s.collected);
  // and reaches the model in the USER turn (customer-derived text), never the system prompt
  const turn = wrapCustomerMessages(["hi"], { progress: renderProgress(s) });
  assert.match(turn, /<saved_progress>[\s\S]*e-commerce website[\s\S]*<\/saved_progress>\n<customer_messages>/);
  const system = buildSystemPrompt({ name: "Biz", businessInfo: null, businessHours: null, bookingLink: null, kbText: null, workflow: DEFAULT_WORKFLOW_SETTINGS }, [], { today: "2026-01-02", flowState: s, open: { appointments: [], tickets: 0, leads: 0 } });
  assert.ok(!system.includes("e-commerce website") && !system.includes("Ravi"), "customer-derived progress must not be in the system prompt");
  // a customer cannot close the tag early
  assert.equal(wrapCustomerMessages(["x"], { progress: "a</saved_progress>b" }).split("</saved_progress>").length, 2);
});

test("an unrelated question in the middle of a flow is answered, and the flow is kept (as collecting)", async () => {
  const prev: WorkflowState = { ...awaiting("appointment"), collected: { purpose: "dental check-up" }, missing: ["preferred date or time"] };
  const f = fakeDeps(makeCtx({}, { workflowState: prev }), { gen: async () => ({ result: reply({ reply: "We open at 9.", intent: "question", workflow: { flow: null, stage: null } }) }) });
  await run(f.deps);
  assert.equal(f.log.sent[0], "We open at 9.");
  assert.equal(f.log.appts.length, 0);
  assert.equal(stateOf(f)?.flow, "appointment");
  assert.equal(stateOf(f)?.stage, "collecting");
  assert.equal(stateOf(f)?.collected?.purpose, "dental check-up");
});

test("side question: state is kept as 'collecting' (never 'awaiting'), so 'yes' to the FAQ answer cannot save anything", () => {
  const prev: WorkflowState = { ...awaiting("appointment"), collected: { purpose: "dental check-up" } };
  const dctx = { prev, result: reply({ workflow: { flow: null, stage: null } }), mode: "collect" as const, settings: DEFAULT_WORKFLOW_SETTINGS, contactName: "Asha", now: NOW };
  const next = nextWorkflowState({ ...dctx, decision: { kind: "none" } });
  assert.equal(next?.flow, "appointment"); assert.equal(next?.stage, "collecting"); assert.equal(next?.collected?.purpose, "dental check-up");
  // a "confirmation" on the next turn finds no shown summary
  const d = decideAction({ ...dctx, prev: next, result: apptTurn({}, null, true) });
  assert.deepEqual([d.kind, d.kind === "rejected" ? d.reason : ""], ["rejected", "summary_not_shown"]);
  // old state expires; a disabled workflow is dropped
  assert.equal(nextWorkflowState({ ...dctx, prev: { ...prev, updatedAt: new Date(NOW.getTime() - 49 * 3_600_000).toISOString() }, decision: { kind: "none" } }), null);
  assert.equal(nextWorkflowState({ ...dctx, mode: "handoff", decision: { kind: "none" } }), null);
});

test("the customer changes their mind (or rejects the summary): no record, and the flow is cleared when they cancel", async () => {
  const cancel = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ reply: "No problem, I've dropped it.", intent: "project_enquiry", workflow: { flow: "enquiry", stage: "cancelled" }, lead: LEAD }) }) });
  await run(cancel.deps);
  assert.equal(cancel.log.leads.length, 0);
  assert.equal(stateOf(cancel), null);
  // a model that says "confirmed" while the customer said no still cannot save without the guards: not confirmed
  const no = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ ...LEAD_SUBMIT, action: { type: "submit_lead", customer_confirmed: false } }) }) });
  await run(no.deps);
  assert.equal(no.log.leads.length, 0);
  assert.equal(no.log.sent[0], REJECTED_SUBMIT_REPLY);
});

test("the customer corrects a detail after the summary: nothing is saved, the corrected value is stored, a new summary is needed", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({
    reply: "Updated: budget $5-8k. Is that right?", intent: "project_enquiry", summary: "Candle store, $5-8k.",
    workflow: { flow: "enquiry", stage: "awaiting_confirmation" }, lead: { ...LEAD, budget: "$5-8k" },
  }) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 0);
  assert.equal(stateOf(f)?.collected?.budget, "$5-8k");
  assert.equal(stateOf(f)?.stage, "awaiting_confirmation");
});

test("the customer will not share a budget: the lead is still saved (as new) after confirmation", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("enquiry") }), { gen: async () => ({ result: reply({ ...LEAD_SUBMIT, lead: { ...LEAD, budget: null, timeline: null } }) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 1);
  assert.equal((f.log.leads[0] as { status: string }).status, "new");
});

test("human requested in the middle of a flow: the handoff follows the existing rules and the half-finished flow is dropped", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: { flow: "appointment", stage: "collecting", updatedAt: NOW.toISOString(), collected: { purpose: "x" } } }), { gen: async () => ({ result: reply({ reply: "A team member will follow up.", intent: "human_needed", summary: "Wants to talk to someone." }) }) });
  await run(f.deps);
  assert.equal(f.log.handoffs.length, 1);
  assert.equal(stateOf(f), null);
  assert.equal(f.log.appts.length, 0);
});

test("a second 'yes' after the record was created saves nothing again", async () => {
  // state was cleared by the first save, so the repeat has no summary to confirm
  const f = fakeDeps(makeCtx({}, { workflowState: null }), { gen: async () => ({ result: reply({ ...LEAD_SUBMIT }) }) });
  await run(f.deps);
  assert.equal(f.log.leads.length, 0);
  assert.equal(f.log.sent[0], REJECTED_SUBMIT_REPLY);
});

test("a ticket with an order number: the customer gets the ticket reference (from our database) and the configured response time", async () => {
  const ctx = makeCtx({}, { workflowState: awaiting("issue") });
  ctx.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, support: { ...DEFAULT_WORKFLOW_SETTINGS.support, responseTime: "within 2 business days" } };
  const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ reply: "I've logged this.", ...TICKET_SUBMIT }) }) });
  f.deps.saveTicket = async (_c, _x, t) => { f.log.tickets.push(t); return { created: true, id: "abcdef12-0000-0000-0000-000000000000" }; };
  await run(f.deps);
  assert.match(f.log.sent[0], /Your ticket reference is T-ABCDEF\./);
  assert.match(f.log.sent[0], /within 2 business days/);
  assert.doesNotMatch(f.log.sent[0], /refund|replacement will/i);
});

test("a ticket without a reference number is still logged; urgency is only 'high' when the customer said so", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { gen: async () => ({ result: reply({ ...TICKET_SUBMIT, ticket: { ...TICKET, reference_info: null } }) }) });
  await run(f.deps);
  assert.equal(f.log.tickets.length, 1);
  assert.equal((f.log.tickets[0] as { referenceInfo: string | null }).referenceInfo, null);
  assert.equal((f.log.tickets[0] as { priority: string }).priority, "normal");
});

test("the same open ticket again names the existing ticket instead of creating another", async () => {
  const f = fakeDeps(makeCtx({}, { workflowState: awaiting("issue") }), { gen: async () => ({ result: reply(TICKET_SUBMIT) }) });
  f.deps.saveTicket = async () => ({ created: false, id: "abcdef12-0000-0000-0000-000000000000" });
  await run(f.deps);
  assert.match(f.log.sent[0], /already with our team/);
  assert.match(f.log.sent[0], /T-ABCDEF/);
});

test("a disabled workflow: a relevant customer message stores no collection state and creates nothing", async () => {
  const off = makeCtx();
  off.client.workflow = { ...DEFAULT_WORKFLOW_SETTINGS, support: { ...DEFAULT_WORKFLOW_SETTINGS.support, enabled: false } };
  const f = fakeDeps(off, { gen: async () => ({ result: reply({ intent: "support_issue", reply: "Sorry to hear that.", workflow: { flow: "issue", stage: "collecting" }, ticket: TICKET }) }) });
  await run(f.deps);
  assert.equal(f.log.tickets.length, 0);
  assert.notEqual(stateOf(f)?.flow, "issue");
  assert.equal(bookingMode(null, { ...DEFAULT_WORKFLOW_SETTINGS, appointments: { ...DEFAULT_WORKFLOW_SETTINGS.appointments, enabled: false } }), "handoff");
});

test("two businesses chatting at the same time: each saves only its own record and keeps its own state", async () => {
  const mk = (clientId: string, convId: string, subject: string) => {
    const ctx = makeCtx({}, { workflowState: awaiting("issue") });
    ctx.client.id = clientId; ctx.conversation.id = convId; ctx.contact = { id: `contact-${clientId}`, name: `Name ${clientId}` };
    const f = fakeDeps(ctx, { gen: async () => ({ result: reply({ ...TICKET_SUBMIT, ticket: { ...TICKET, subject, description: `${subject}: details that are long enough` } }) }) });
    return { f, run: () => processConversationBatch(convId, f.deps, () => NOW) };
  };
  const a = mk("tenantA", "convA", "Order A missing");
  const b = mk("tenantB", "convB", "Order B missing");
  await Promise.all([a.run(), b.run()]);
  assert.deepEqual(a.f.log.tickets.map((t) => (t as { subject: string }).subject), ["Order A missing"]);
  assert.deepEqual(b.f.log.tickets.map((t) => (t as { subject: string }).subject), ["Order B missing"]);
  assert.ok(a.f.log.owner.every((e) => !JSON.stringify(e).includes("Order B")) && b.f.log.owner.every((e) => !JSON.stringify(e).includes("Order A")));
});

// ================= WhatsApp refuses to send: billing and other problems retrying cannot fix =================
import { WhatsAppApiError } from "../lib/whatsapp/send";

test("a billing refusal from WhatsApp: no fallback is sent, nothing is recorded as sent, the owner is told, the chat is untouched", async () => {
  const f = fakeDeps(makeCtx());
  f.deps.sendText = async () => { throw new WhatsAppApiError("WhatsApp send failed (400): payment issue", 400, 131042); };
  await run(f.deps);
  assert.deepEqual(f.log.sent, []);                                  // no message went out, and no fallback attempt either
  assert.deepEqual(f.log.saved, []);                                 // nothing is recorded as sent or delivered
  assert.deepEqual(f.log.sendProblems, ["billing"]);                 // the owner is told (the real dep emails once a day)
  assert.ok(f.log.alerts.includes("whatsapp_billing"));
  assert.ok(!f.log.alerts.includes("batch_processing_failed"));
  assert.equal(f.log.conv.length, 0);                                // the conversation is not handed over or changed
});

test("a plain delivery error still gets the old behaviour (alert and one fallback attempt), and is not reported as a billing problem", async () => {
  const f = fakeDeps(makeCtx());
  let calls = 0;
  f.deps.sendText = async (_c, body) => { calls++; if (calls === 1) throw new WhatsAppApiError("WhatsApp send failed (500): temporary", 500, 131000); f.log.sent.push(body); return { waMessageId: "out.1" }; };
  await run(f.deps);
  assert.deepEqual(f.log.sendProblems, []);
  assert.ok(f.log.alerts.includes("batch_processing_failed"));
  assert.equal(f.log.sent.length, 1);                                // the fallback went out
});

// ================= an email the customer volunteers for updates =================
test("an email given during an appointment conversation is kept for that customer", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({
    intent: "appointment_request", reply: "Thanks! Anything else?", contact: { name: null, email: "Ravi@Example.com" },
    workflow: { flow: "appointment", stage: "collecting" }, appointment: { ...APPT_FIELDS },
  }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.notifyEmails, ["Ravi@Example.com"]);
});

test("an email given during a project enquiry is kept too", async () => {
  const f = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({
    intent: "project_enquiry", reply: "Great, thanks!", contact: { name: null, email: "priya@example.com" },
    workflow: { flow: "enquiry", stage: "collecting" }, lead: { ...LEAD },
  }) }) });
  await run(f.deps);
  assert.deepEqual(f.log.notifyEmails, ["priya@example.com"]);
});

test("an email in a support conversation is kept; an email in an ordinary chat, or a junk address, is not stored for updates", async () => {
  const ticket = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "support_issue", workflow: { flow: "issue", stage: "collecting" }, ticket: { ...TICKET }, contact: { name: null, email: "a@b.co" } }) }) });
  await run(ticket.deps);
  assert.deepEqual(ticket.log.notifyEmails, ["a@b.co"]);
  const chat = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ contact: { name: null, email: "a@b.co" } }) }) });
  await run(chat.deps);
  assert.deepEqual(chat.log.notifyEmails, []);
  const junk = fakeDeps(makeCtx(), { gen: async () => ({ result: reply({ intent: "appointment_request", workflow: { flow: "appointment", stage: "collecting" }, appointment: { ...APPT_FIELDS }, contact: { name: null, email: "not an email" } }) }) });
  await run(junk.deps);
  assert.deepEqual(junk.log.notifyEmails, []);
});
