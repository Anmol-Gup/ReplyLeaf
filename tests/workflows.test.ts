import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedActions, appointmentFormSchema, customerMessage, formProblem, isUpcoming, nextStatus, overview, rescheduleNote,
  APPOINTMENT_ACTIONS, APPOINTMENT_STATUSES,
} from "../lib/appointments";
import { LEAD_STATUSES, leadFormSchema, leadOverview, projectBrief } from "../lib/leads";
import { eventCategory, parseEmails, parseOneEmail, recipientsFor, type NotificationSettings } from "../lib/notify-settings";
import { CONFIRMATION_TTL_MS, decideAction, leadDedupeKey, nextWorkflowState, parseWorkflowState, validateAppointment, validateLead, validPreferredDate } from "../lib/workflow";
import { bookingMode, DEFAULT_WORKFLOW_SETTINGS, linesToList, parseWorkflowSettings, renderWorkflowRules } from "../lib/workflow-settings";
import { baseReply } from "./fixtures";

const NOW = new Date("2026-01-02T12:00:00Z");

// ---- appointment status rules ----
test("appointment moves follow the lifecycle and refuse everything else", () => {
  assert.equal(nextStatus("pending", "confirm"), "confirmed");
  assert.equal(nextStatus("pending", "reject"), "rejected");
  assert.equal(nextStatus("pending", "reschedule"), "reschedule_requested");
  assert.equal(nextStatus("reschedule_requested", "confirm"), "confirmed");
  assert.equal(nextStatus("confirmed", "complete"), "completed");
  assert.equal(nextStatus("confirmed", "reschedule"), "reschedule_requested");
  assert.equal(nextStatus("pending", "complete"), null); // only confirmed ones can be completed
  assert.equal(nextStatus("confirmed", "confirm"), null);
  for (const a of APPOINTMENT_ACTIONS) for (const s of ["rejected", "cancelled", "completed"] as const) assert.equal(nextStatus(s, a), null);
  assert.deepEqual(allowedActions("cancelled"), []);
  assert.equal(APPOINTMENT_STATUSES.length, 6);
});

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

test("customer messages never claim more than is true and never leak internal notes", () => {
  const confirm = customerMessage("confirm", { purpose: "check-up", when: "2026-01-09 10am" }, "Biz");
  assert.match(confirm, /confirmed for 2026-01-09 10am/);
  assert.match(customerMessage("reschedule", { purpose: "check-up", when: "", note: "Friday 3pm" }, "Biz"), /Suggested: Friday 3pm/);
  assert.match(customerMessage("reject", { purpose: "check-up", when: "", note: "Fully booked" }, "Biz"), /Fully booked/);
  assert.match(customerMessage("cancel", { purpose: "check-up", when: "" }, "Biz"), /cancelled/);
  // the message builders only take the customer-facing fields: there is no parameter for internal notes
  assert.equal(customerMessage.length, 3);
});

test("appointment form: real id, known action, real date; reschedule needs an alternative", () => {
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  assert.ok(appointmentFormSchema.safeParse({ id, action: "confirm", date: "2026-01-09" }).success);
  assert.ok(appointmentFormSchema.safeParse({ id, action: "confirm", date: "" }).success);
  assert.ok(!appointmentFormSchema.safeParse({ id, action: "confirm", date: "2026-02-31" }).success);
  assert.ok(!appointmentFormSchema.safeParse({ id: "x", action: "confirm" }).success);
  assert.ok(!appointmentFormSchema.safeParse({ id, action: "delete" }).success);
  assert.ok(formProblem("reschedule", {}) !== null);
  assert.equal(formProblem("reschedule", { note: "Friday" }), null);
  assert.equal(formProblem("confirm", {}), null);
  assert.equal(rescheduleNote({ date: "2026-01-09", time: "3pm", note: "we are full" }), "2026-01-09 3pm - we are full");
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

const awaiting = (flow: "appointment" | "enquiry", ageMs = 0) => ({ flow, stage: "awaiting_confirmation" as const, updatedAt: new Date(NOW.getTime() - ageMs).toISOString() });
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
  const rules = renderWorkflowRules(parseWorkflowSettings({ appointments: { instructions: "Ask about insurance." }, enquiries: { services: ["Websites", "Apps"], budgetRanges: ["<$1k", "$1-5k"] }, handoff: { responseTime: "within 1 business day" } }), null, "2026-01-02");
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
  const s: NotificationSettings = { primaryEmail: "boss@x.com", additionalEmails: ["a@x.com", "BOSS@x.com"], appointments: true, leads: false, handoffs: true };
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
