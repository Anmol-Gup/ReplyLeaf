import { test } from "node:test";
import assert from "node:assert/strict";
import { businessStatus, cleanContact, DEFAULT_WORKFLOW_SETTINGS, formToWorkflowInput, outOfHoursNote, parseWorkflowSettings, renderClosedHours, renderWorkflowRules, workflowSettingsSchema } from "../lib/workflow-settings";
import { appointmentWindowIssue } from "../lib/workflow";
import { buildSystemPrompt, type PromptClient } from "../lib/ai/prompt";

// Business hours and contact: decided by code in the business time zone, then told to the assistant.
const settings = (over: { appointments?: object; business?: object } = {}) => workflowSettingsSchema.parse({
  appointments: { workingDays: ["mon", "tue", "wed", "thu", "fri"], openTime: "09:00", closeTime: "17:00", timezone: "Asia/Kolkata", ...over.appointments },
  business: { contact: "", ...over.business },
});
const NOW = new Date("2026-01-02T12:00:00Z"); // a Friday

test("the contact is optional and business-wide: empty by default; the text once saved under appointments is carried over", () => {
  assert.equal(DEFAULT_WORKFLOW_SETTINGS.business.contact, "");
  assert.equal(parseWorkflowSettings({ appointments: { openTime: "10:00" } }).business.contact, "");
  assert.equal(parseWorkflowSettings({ appointments: { outOfHoursContact: "Call 123" } }).business.contact, "Call 123");
  assert.equal(parseWorkflowSettings({ appointments: { outOfHoursContact: "old" }, business: { contact: "new" } }).business.contact, "new");
});

test("the settings form fills business.contact, trimmed and capped at 300 characters", () => {
  const input = formToWorkflowInput((n) => (n === "business_contact" ? "  Call +91 98765 43210  " : n === "appointments_enabled" ? "on" : null));
  assert.equal(workflowSettingsSchema.parse(input).business.contact, "Call +91 98765 43210");
  assert.equal(workflowSettingsSchema.safeParse({ business: { contact: "x".repeat(301) } }).success, false);
});

test("cleanContact makes one safe line: no line breaks or control characters, never longer than 300", () => {
  assert.equal(cleanContact("Call 123\n\nor email a@b.com\u0007"), "Call 123 or email a@b.com");
  assert.equal(cleanContact(null), ""); assert.equal(cleanContact("x".repeat(500)).length, 300);
});

test("an appointment day or time you do not work gets the contact details in the same message; with none set it is unchanged", () => {
  const a = settings().appointments;
  const sat = appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW, "Call +91 98765 43210") ?? "";
  assert.match(sat, /Saturday/); assert.match(sat, /You can also reach us at: Call \+91 98765 43210\./);
  assert.match(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "8pm" }, a, NOW, "hello@biz.com") ?? "", /09:00 to 17:00.*reach us at: hello@biz\.com\./);
  assert.doesNotMatch(appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "", /reach us/);
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, a, NOW, "hello@biz.com"), null);
});

test("businessStatus: open and closed in the business's own time zone (India is 5h30 ahead of UTC)", () => {
  const s = settings();
  assert.equal(businessStatus(new Date("2026-01-02T05:00:00Z"), s)?.open, true);   // Fri 10:30 IST
  assert.equal(businessStatus(new Date("2026-01-02T11:29:00Z"), s)?.open, true);   // Fri 16:59 IST
  assert.equal(businessStatus(new Date("2026-01-02T11:30:00Z"), s)?.open, false);  // Fri 17:00 IST: closing time itself is closed
  assert.equal(businessStatus(new Date("2026-01-02T03:29:00Z"), s)?.open, false);  // Fri 08:59 IST
  assert.equal(businessStatus(new Date("2026-01-02T03:30:00Z"), s)?.open, true);   // Fri 09:00 IST
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.open, false);  // Sat 11:30 IST: not a working day
});

test("businessStatus says when the business is next available", () => {
  const s = settings();
  assert.equal(businessStatus(new Date("2026-01-02T02:00:00Z"), s)?.nextOpen, "today at 09:00");      // Fri 07:30 IST
  assert.equal(businessStatus(new Date("2026-01-01T15:30:00Z"), s)?.nextOpen, "tomorrow at 09:00");   // Thu 21:00 IST
  assert.equal(businessStatus(new Date("2026-01-02T12:00:00Z"), s)?.nextOpen, "Monday at 09:00");     // Fri 17:30 IST
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.nextOpen, "Monday at 09:00");     // Sat
  assert.match(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.now ?? "", /^Saturday 11:30 \(Asia\/Kolkata\)$/);
});

test("businessStatus claims nothing without a time zone, and no ticked days means every day counts", () => {
  assert.equal(businessStatus(NOW, settings({ appointments: { timezone: null } })), null);
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), settings({ appointments: { workingDays: [] } }))?.open, true); // Sat 11:30 IST
  assert.equal(businessStatus(new Date("2026-01-02T18:30:00Z"), settings())?.open, false); // Sat 00:00 IST (midnight must not crash)
});

test("while closed the assistant is told so, with the reopening time and the owner's contact text; open or unknown adds nothing", () => {
  const s = settings({ business: { contact: "Call +91 98765 43210 or email hello@biz.com" } });
  const closed = renderClosedHours(s, businessStatus(new Date("2026-01-03T06:00:00Z"), s));
  assert.match(closed, /CLOSED right now/); assert.match(closed, /Saturday 11:30/); assert.match(closed, /next available Monday at 09:00/);
  assert.match(closed, /Call \+91 98765 43210 or email hello@biz\.com/); assert.match(closed, /Share no other phone number or email/);
  assert.match(closed, /answering questions from the business knowledge exactly as usual/);
  assert.equal(renderClosedHours(s, businessStatus(new Date("2026-01-02T05:00:00Z"), s)), "");
  assert.equal(renderClosedHours(s, null), "");
  const bare = renderClosedHours(settings(), businessStatus(new Date("2026-01-03T06:00:00Z"), settings()));
  assert.match(bare, /next available Monday at 09:00/); assert.doesNotMatch(bare, /contact details/);
});

test("the system prompt carries the closed-hours rule only while closed", () => {
  const client = { name: "Biz", businessInfo: null, businessHours: null, bookingLink: null, kbText: "Open Mon-Fri", workflow: settings({ business: { contact: "Call 123" } }) } as unknown as PromptClient;
  const ctx = (now: Date) => ({ today: "2026-01-03", now, flowState: null, open: { appointments: [], tickets: 0, leads: 0 } });
  assert.match(buildSystemPrompt(client, [], ctx(new Date("2026-01-03T06:00:00Z"))), /CLOSED right now[\s\S]*Call 123/);
  assert.doesNotMatch(buildSystemPrompt(client, [], ctx(new Date("2026-01-02T05:00:00Z"))), /CLOSED right now/);
});

test("the appointment rule shares the same business contact, only when it is set", () => {
  assert.equal(outOfHoursNote(""), "");
  assert.match(outOfHoursNote("Call +91 98765 43210"), /never any other phone number/);
  const set = settings({ business: { contact: "Call +91 98765 43210" } });
  assert.match(renderWorkflowRules(set, null, "2026-01-02"), /Call \+91 98765 43210/);
  assert.doesNotMatch(renderWorkflowRules(DEFAULT_WORKFLOW_SETTINGS, null, "2026-01-02"), /share these contact details/);
});
