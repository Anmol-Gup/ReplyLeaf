import { test } from "node:test";
import assert from "node:assert/strict";
import { isUpcoming, overview, APPOINTMENT_STATUSES } from "../lib/appointments";
import { TICKET_STATUSES, cleanAssignedTo, isOpenTicket, resolvedAtFor, resolutionMessage, ticketFormSchema, ticketOverview, ticketRef } from "../lib/tickets";
import { LEAD_STATUSES, leadFormSchema, leadOverview, projectBrief } from "../lib/leads";
import { eventCategory, parseEmails, parseOneEmail, recipientsFor, type NotificationSettings } from "../lib/notify-settings";
import { CONFIRMATION_TTL_MS, appointmentDedupeKey, decideAction, leadDedupeKey, validateTicket, nextWorkflowState, parseWorkflowState, validateAppointment, validateLead, validPreferredDate } from "../lib/workflow";
import { bookingMode, DEFAULT_WORKFLOW_SETTINGS, formToWorkflowInput, linesToList, parseWorkflowSettings, renderWorkflowRules, workflowSettingsSchema } from "../lib/workflow-settings";
import { buildTimeline } from "../lib/timeline";
import { baseReply } from "./fixtures";

const NOW = new Date("2026-01-02T12:00:00Z");

// ---- appointment status rules ----
test("upcoming = confirmed and not in the past; overview counts", () => {
  const rows = [
    { status: "pending" as const, scheduled_date: null, preferred_date: "2026-02-01" },
    { status: "confirmed" as const, scheduled_date: "2026-01-10", preferred_date: null },
    { status: "confirmed" as const, scheduled_date: "2025-12-01", preferred_date: null },
    { status: "reschedule_requested" as const, scheduled_date: null, preferred_date: null },
    { status: "rejected" as const, scheduled_date: null, preferred_date: null },
    { status: "cancelled" as const, scheduled_date: null, preferred_date: null },
  ];
  assert.equal(isUpcoming(rows[1], "2026-01-02"), true);
  assert.equal(isUpcoming(rows[2], "2026-01-02"), false);
  assert.equal(isUpcoming(rows[0], "2026-01-02"), false);
  assert.deepEqual(overview(rows, "2026-01-02"), { pending: 2, upcoming: 1, confirmed: 2, closed: 2 });
});

// ---- workflow decision rules ----
test("dates: only real dates from today to a year ahead are accepted", () => {
  assert.equal(validPreferredDate("2026-01-09", NOW), "2026-01-09");
  assert.equal(validPreferredDate("2026-01-02", NOW), "2026-01-02"); // today is fine
  assert.equal(validPreferredDate("2026-01-01", NOW), null);          // past
  assert.equal(validPreferredDate("2027-06-01", NOW), null);          // too far
  assert.equal(validPreferredDate("2026-02-30", NOW), null);          // not a real day
  assert.equal(validPreferredDate("next friday", NOW), null);
  assert.equal(validPreferredDate(null, NOW), null);
});

test("appointment needs a purpose, a date or time, and a name (the chat's contact name counts)", () => {
  const ok = baseReply().appointment;
  const full = { ...ok, purpose: "check-up", preferred_time: "10am", customer_name: null };
  assert.equal(validateAppointment(full, "Asha", NOW).ok, true);
  const noName = validateAppointment(full, null, NOW);
  assert.ok(!noName.ok && noName.missing.includes("name"));
  const noWhen = validateAppointment({ ...full, preferred_time: null }, "Asha", NOW);
  assert.ok(!noWhen.ok && noWhen.missing.includes("preferred date or time"));
  const r = validateAppointment({ ...full, purpose: "  check-up\n\u0000 now ", notes: "x".repeat(900) }, "Asha", NOW);
  assert.ok(r.ok && r.value.purpose === "check-up now" && (r.value.notes?.length ?? 0) <= 500);
});

test("lead: qualified only with budget AND timeline; thin descriptions are refused; same enquiry = same key", () => {
  const l = { project_type: "website", description: "A shop for handmade candles", budget: "$3k", timeline: "6 weeks", requirements: [{ key: "platform", value: "Shopify" }, { key: " ", value: "x" }] };
  const full = validateLead(l, "Wants a candle shop.", "Asha");
  assert.ok(full.ok && full.value.status === "qualified" && full.value.requirements.length === 1);
  const noBudget = validateLead({ ...l, budget: null }, null, null);
  assert.ok(noBudget.ok && noBudget.value.status === "new");
  assert.ok(!validateLead({ ...l, description: "site" }, null, null).ok);
  assert.ok(!validateLead({ ...l, project_type: null }, null, null).ok);
  assert.equal(leadDedupeKey("Website", "A  shop"), leadDedupeKey("website", "a shop"));
  assert.notEqual(leadDedupeKey("website", "a shop"), leadDedupeKey("app", "a shop"));
});

const awaiting = (flow: "appointment" | "enquiry" | "issue", ageMs = 0) => ({ flow, stage: "awaiting_confirmation" as const, updatedAt: new Date(NOW.getTime() - ageMs).toISOString() });
const submitAppt = baseReply({
  workflow: { flow: "appointment", stage: null },
  appointment: { purpose: "check-up", preferred_date: "2026-01-09", preferred_time: "10am", timezone: null, appointment_type: null, notes: null, customer_name: "Asha" },
  action: { type: "submit_appointment", customer_confirmed: true },
});
const dec = (over: Partial<Parameters<typeof decideAction>[0]> = {}) => decideAction({
  prev: awaiting("appointment"), result: submitAppt, mode: "collect", settings: DEFAULT_WORKFLOW_SETTINGS, contactName: null, now: NOW, ...over,
});

test("decideAction saves only when every guard passes", () => {
  assert.equal(dec().kind, "appointment");
  assert.equal(dec({ prev: null }).kind, "rejected");                                  // no summary shown
  assert.equal(dec({ prev: { flow: "appointment", stage: "collecting", updatedAt: NOW.toISOString() } }).kind, "rejected");
  assert.equal(dec({ prev: awaiting("enquiry") }).kind, "rejected");                  // wrong flow
  assert.equal(dec({ prev: awaiting("appointment", CONFIRMATION_TTL_MS + 1) }).kind, "rejected"); // stale
  assert.equal(dec({ mode: "link" }).kind, "rejected");                               // a booking link means no collecting
  assert.equal(dec({ mode: "handoff" }).kind, "rejected");
  assert.equal(dec({ result: { ...submitAppt, action: { type: "submit_appointment", customer_confirmed: false } } }).kind, "rejected");
  assert.equal(dec({ result: baseReply() }).kind, "none");
});

test("state machine: collecting -> awaiting only when details are complete; cleared after a save", () => {
  const collecting = baseReply({ workflow: { flow: "appointment", stage: "awaiting_confirmation" }, appointment: { ...submitAppt.appointment, purpose: null } });
  const base = { prev: null, mode: "collect" as const, settings: DEFAULT_WORKFLOW_SETTINGS, contactName: null, now: NOW };
  // the model claims it showed a summary but the purpose is missing: we do not believe it
  assert.equal(nextWorkflowState({ ...base, result: collecting, decision: { kind: "none" } })?.stage, "collecting");
  const complete = baseReply({ workflow: { flow: "appointment", stage: "awaiting_confirmation" }, appointment: submitAppt.appointment });
  assert.equal(nextWorkflowState({ ...base, result: complete, decision: { kind: "none" } })?.stage, "awaiting_confirmation");
  const saved = decideAction({ ...base, prev: awaiting("appointment"), result: submitAppt });
  assert.equal(nextWorkflowState({ ...base, prev: awaiting("appointment"), result: submitAppt, decision: saved }), null);
  // a rejected submit drops back to collecting so the summary gets shown again
  assert.equal(nextWorkflowState({ ...base, result: submitAppt, decision: { kind: "rejected", flow: "appointment", reason: "x" } })?.stage, "collecting");
  // the feature is off: no state is kept
  assert.equal(nextWorkflowState({ ...base, mode: "link", result: complete, decision: { kind: "none" } }), null);
});

test("stored workflow state is parsed defensively", () => {
  assert.equal(parseWorkflowState(null), null);
  assert.equal(parseWorkflowState({ flow: "hack", stage: "collecting" }), null);
  assert.equal(parseWorkflowState({ flow: "enquiry", stage: "collecting", updatedAt: "2026-01-01T00:00:00Z" })?.flow, "enquiry");
});

// ---- settings ----
test("settings: defaults, bad stored data, booking mode", () => {
  assert.equal(DEFAULT_WORKFLOW_SETTINGS.appointments.enabled, true);
  assert.deepEqual(DEFAULT_WORKFLOW_SETTINGS.appointments.workingDays, ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual(parseWorkflowSettings({ appointments: { openTime: "25:99" } }), DEFAULT_WORKFLOW_SETTINGS); // invalid -> defaults
  assert.equal(parseWorkflowSettings({ handoff: { enabled: false } }).handoff.enabled, false);
  assert.equal(parseWorkflowSettings({ handoff: { enabled: false } }).enquiries.enabled, true);
  assert.equal(bookingMode("https://x", DEFAULT_WORKFLOW_SETTINGS), "link");
  assert.equal(bookingMode(null, DEFAULT_WORKFLOW_SETTINGS), "collect");
  assert.equal(bookingMode(null, parseWorkflowSettings({ appointments: { enabled: false } })), "handoff");
  assert.deepEqual(linesToList("a\n\n b \nA\nc", 3, 10), ["a", "b", "c"]);
});

test("prompt rules follow the settings and never promise availability", () => {
  const rules = renderWorkflowRules(parseWorkflowSettings({ appointments: { instructions: "Ask about insurance." }, enquiries: { services: ["Websites", "Apps"] }, handoff: { responseTime: "within 1 business day" } }), null, "2026-01-02");
  assert.match(rules, /never promise that a day or time is free/);
  assert.match(rules, /Ask about insurance\./);
  assert.match(rules, /Websites; Apps/);
  assert.match(rules, /within 1 business day/);
  assert.match(rules, /Today's date is 2026-01-02/);
  const off = renderWorkflowRules(parseWorkflowSettings({ handoff: { enabled: false }, enquiries: { enabled: false } }), null, "2026-01-02");
  assert.match(off, /HUMAN HANDOFF: disabled/);
  assert.match(off, /PROJECT ENQUIRIES: not enabled/);
});

// ---- notifications ----
test("recipients: switches per category, primary falls back to the owner email, extras de-duplicated", () => {
  const s: NotificationSettings = { primaryEmail: "boss@x.com", additionalEmails: ["a@x.com", "BOSS@x.com"], appointments: true, leads: false, handoffs: true, tickets: true };
  assert.deepEqual(recipientsFor(s, "owner@x.com", "appointment"), ["boss@x.com", "a@x.com"]);
  assert.deepEqual(recipientsFor(s, "owner@x.com", "lead"), []);            // lead emails switched off
  assert.deepEqual(recipientsFor(s, "owner@x.com", "always"), ["boss@x.com", "a@x.com"]); // onboarding mail ignores the switches
  assert.deepEqual(recipientsFor(null, "owner@x.com", "handoff"), ["owner@x.com"]);
  assert.deepEqual(recipientsFor({ ...s, primaryEmail: null }, "owner@x.com", "handoff"), ["owner@x.com", "a@x.com", "boss@x.com"]);
  assert.deepEqual(recipientsFor(null, null, "lead"), []);
});

test("email lists: valid ones kept, junk reported, capped", () => {
  const r = parseEmails("a@x.com, b@x.com; nope  A@X.com\nc@y.org");
  assert.deepEqual(r.emails, ["a@x.com", "b@x.com", "c@y.org"]);
  assert.deepEqual(r.invalid, ["nope"]);
  assert.ok(parseEmails("1@a.com 2@a.com 3@a.com 4@a.com 5@a.com 6@a.com").tooMany);
  assert.equal(parseOneEmail("  Boss@X.com "), "boss@x.com");
  assert.equal(parseOneEmail("bad"), null);
});

test("each event maps to the right notification category", () => {
  assert.equal(eventCategory({ type: "needs_human", contactName: null, phone: "1", reason: "owner", lastMessage: "", summary: "" }), "handoff");
  assert.equal(eventCategory({ type: "lead_created", contactName: null, phone: "1", projectType: "x", budget: null, timeline: null, summary: "", status: "new" }), "lead");
  assert.equal(eventCategory({ type: "appointment_update", status: "confirmed", contactName: null, phone: "1", purpose: "x", when: null, note: null }), "appointment");
  assert.equal(eventCategory({ type: "onboarded", businessName: "x" }), "always");
});

// ---- leads ----
test("lead statuses, form validation, brief and overview", () => {
  assert.equal(LEAD_STATUSES.length, 7);
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  assert.ok(leadFormSchema.safeParse({ id, status: "won", follow_up_at: "", notes: "" }).success);
  assert.ok(!leadFormSchema.safeParse({ id, status: "closed", follow_up_at: "", notes: "" }).success);
  assert.ok(!leadFormSchema.safeParse({ id, status: "new", follow_up_at: "soon", notes: "" }).success);
  const brief = projectBrief({ customer_name: "Asha", customer_phone: "911", project_type: "website", description: "Candle shop", budget: null, timeline: "6 weeks", status: "qualified", ai_summary: "Wants a shop.", follow_up_at: "2026-02-01", created_at: "2026-01-02T10:00:00Z" },
    [{ requirement_key: "platform", requirement_value: "Shopify" }], "Biz");
  assert.match(brief, /PROJECT BRIEF: website/);
  assert.match(brief, /Budget: not given/);
  assert.match(brief, /platform: Shopify/);
  assert.doesNotMatch(brief, /internal/i);
  assert.deepEqual(leadOverview([{ status: "new", follow_up_at: "2026-01-01" }, { status: "won", follow_up_at: null }, { status: "contacted", follow_up_at: "2026-03-01" }], "2026-01-02"),
    { total: 3, fresh: 1, open: 2, dueFollowUp: 1, won: 1 });
});

test("settings form -> validated settings (unchecked boxes are off, lists come from lines, bad numbers are rejected)", () => {
  const fields: Record<string, string> = {
    appointments_enabled: "on", day_mon: "on", day_wed: "on", open_time: "08:30", close_time: "17:00",
    appointment_instructions: " Ask if new patient ", services: "Web\n\nApps\nweb", questions: "", availability: "Mon-Fri", response_time: "1 day",
  };
  const get = (n: string) => (n in fields ? fields[n] : null);
  const parsed = parseWorkflowSettings(formToWorkflowInput(get));
  assert.equal(parsed.appointments.enabled, true);
  assert.deepEqual(parsed.appointments.workingDays, ["mon", "wed"]);
  assert.equal(parsed.appointments.instructions, "Ask if new patient");
  assert.deepEqual(parsed.enquiries.services, ["Web", "Apps"]);
  assert.equal(parsed.enquiries.enabled, false); // checkbox not sent = off
  assert.equal(parsed.handoff.enabled, false);
  assert.equal(parsed.handoff.responseTime, "1 day");
  // strict validation (what the save action uses): a nonsense number fails instead of being stored
  assert.equal(workflowSettingsSchema.safeParse(formToWorkflowInput((n) => (n === "open_time" ? "25:00" : null))).success, false);
  assert.equal(workflowSettingsSchema.safeParse(formToWorkflowInput(() => null)).success, true);
});

// ---- several open appointments + support tickets ----
test("appointment duplicate key: the same request is the same key, a different purpose or time is not", () => {
  const a = { purpose: "Check-up", preferredDate: "2026-01-09", preferredTime: "10am" };
  assert.equal(appointmentDedupeKey(a), appointmentDedupeKey({ purpose: " check-up ", preferredDate: "2026-01-09", preferredTime: "10AM" }));
  assert.notEqual(appointmentDedupeKey(a), appointmentDedupeKey({ ...a, purpose: "Whitening" }));   // same slot, different purpose: allowed
  assert.notEqual(appointmentDedupeKey(a), appointmentDedupeKey({ ...a, preferredTime: "11am" }));
  assert.notEqual(appointmentDedupeKey(a), appointmentDedupeKey({ ...a, preferredDate: null }));
});

test("ticket needs a subject and a real description; priority defaults to normal", () => {
  const t = { subject: "Order not delivered", description: "Order 4521 has not arrived after 10 days", category: " delivery ", reference_info: "4521", priority: null };
  const ok = validateTicket(t, "Order 4521 not delivered.", "Asha");
  assert.ok(ok.ok && ok.value.priority === "normal" && ok.value.category === "delivery" && ok.value.customerName === "Asha");
  assert.ok(validateTicket({ ...t, priority: "high" }, null, null).ok);
  assert.ok(!validateTicket({ ...t, subject: null }, null, null).ok);
  assert.ok(!validateTicket({ ...t, description: "bad" }, null, null).ok);
  const high = validateTicket({ ...t, priority: "high" }, null, null);
  assert.ok(high.ok && high.value.priority === "high" && high.value.summary.startsWith("Order not delivered"));
});

test("decideAction: a ticket needs support switched on, a shown summary and confirmation", () => {
  const submit = baseReply({
    intent: "support_issue", workflow: { flow: "issue", stage: null },
    ticket: { subject: "Order not delivered", description: "Order 4521 has not arrived after 10 days", category: null, reference_info: null, priority: null },
    action: { type: "submit_ticket", customer_confirmed: true },
  });
  const base = { mode: "collect" as const, settings: DEFAULT_WORKFLOW_SETTINGS, contactName: "Asha", now: NOW };
  assert.equal(decideAction({ ...base, prev: awaiting("issue"), result: submit }).kind, "ticket");
  assert.equal(decideAction({ ...base, prev: null, result: submit }).kind, "rejected");
  assert.equal(decideAction({ ...base, prev: awaiting("appointment"), result: submit }).kind, "rejected"); // wrong flow
  assert.equal(decideAction({ ...base, settings: parseWorkflowSettings({ support: { enabled: false } }), prev: awaiting("issue"), result: submit }).kind, "rejected");
  // a ticket works even when appointments are off (they are separate features)
  assert.equal(decideAction({ ...base, mode: "handoff", prev: awaiting("issue"), result: submit }).kind, "ticket");
});

test("ticket status rules, reference and form validation", () => {
  assert.equal(TICKET_STATUSES.length, 5);
  assert.deepEqual(TICKET_STATUSES.filter(isOpenTicket), ["open", "in_progress", "waiting_on_customer"]);
  assert.match(ticketRef("7c9e6679-7425-40de-944b-e07fc1f90ae7"), /^T-7C9E66$/);
  const now = new Date("2026-02-01T00:00:00Z");
  assert.equal(resolvedAtFor("resolved", "open", null, now), now.toISOString());
  assert.equal(resolvedAtFor("closed", "resolved", "2026-01-15T00:00:00Z", now), "2026-01-15T00:00:00Z"); // resolved -> closed keeps the first date
  assert.equal(resolvedAtFor("open", "resolved", "2026-01-15T00:00:00Z", now), null);                         // reopened
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  assert.ok(ticketFormSchema.safeParse({ id, status: "resolved", assigned_to: "", notes: "", message: "" }).success);
  assert.ok(!ticketFormSchema.safeParse({ id, status: "deleted", assigned_to: "", notes: "", message: "" }).success);
  assert.equal(cleanAssignedTo("  Priya\u0000  S "), "Priya S");
  assert.equal(cleanAssignedTo("x".repeat(101)), null);
  assert.deepEqual(ticketOverview([{ status: "open", priority: "high" }, { status: "waiting_on_customer", priority: "normal" }, { status: "closed", priority: "high" }]), { open: 1, inProgress: 1, urgent: 1, done: 1 });
});

test("the resolution message names the issue and reference and cannot carry internal notes", () => {
  const m = resolutionMessage("Biz", "Order not delivered", "T-1A2B3C", "A replacement ships today.");
  assert.match(m, /Order not delivered/);
  assert.match(m, /T-1A2B3C/);
  assert.match(m, /replacement ships today/);
  assert.equal(resolutionMessage.length, 4); // only customer-facing inputs: there is no parameter for internal notes
});

test("settings: the support section has defaults, the form maps to it, and the prompt follows it", () => {
  assert.equal(DEFAULT_WORKFLOW_SETTINGS.support.enabled, true);
  const parsed = parseWorkflowSettings(formToWorkflowInput((n) => ({ support_enabled: "on", support_categories: "delivery\nbilling", support_response_time: "2 days" } as Record<string, string>)[n] ?? null));
  assert.deepEqual(parsed.support.categories, ["delivery", "billing"]);
  assert.equal(parsed.support.responseTime, "2 days");
  const rules = renderWorkflowRules(parsed, null, "2026-01-02");
  assert.match(rules, /SUPPORT TICKETS: when the customer reports a problem/);
  assert.match(rules, /Never promise a refund/);
  assert.match(rules, /delivery; billing/);
  assert.match(renderWorkflowRules(parseWorkflowSettings({ support: { enabled: false } }), null, "2026-01-02"), /SUPPORT TICKETS: not enabled/);
});

test("customer timeline merges every kind of record, newest first, with links and open flags", () => {
  const tl = buildTimeline({
    leads: [{ id: "L1", project_type: "website", budget: "$3k", status: "qualified", created_at: "2026-01-01T10:00:00Z" }],
    appointments: [{ id: "A1", purpose: "check-up", preferred_date: "2026-02-01", preferred_time: "10am", scheduled_date: null, scheduled_time: null, status: "pending", created_at: "2026-01-03T10:00:00Z" }],
    tickets: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", subject: "Order not delivered", priority: "high", status: "resolved", created_at: "2026-01-02T10:00:00Z" }],
    handoffs: [{ id: "H1", conversation_id: "C1", reason: "asked for a person", status: "requested", created_at: "2026-01-04T10:00:00Z" }],
  });
  assert.deepEqual(tl.map((t) => t.kind), ["handoff", "appointment", "ticket", "lead"]);
  assert.equal(tl[1].href, "/dashboard/appointments/A1");
  assert.equal(tl[1].detail, "2026-02-01 10am");
  assert.equal(tl[2].open, false);          // resolved ticket
  assert.equal(tl[0].open, true);
  assert.match(tl[2].title, /T-7C9E66: Order not delivered/);
  assert.equal(tl[3].href, "/dashboard/leads/L1");
  assert.deepEqual(buildTimeline({ leads: [], appointments: [], tickets: [], handoffs: [] }), []);
});
