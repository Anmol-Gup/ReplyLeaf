import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanContact, DEFAULT_WORKFLOW_SETTINGS, formToWorkflowInput, outOfHoursNote, parseWorkflowSettings, renderWorkflowRules, workflowSettingsSchema } from "../lib/workflow-settings";
import { appointmentWindowIssue } from "../lib/workflow";

// Contact details shared when a customer asks for a day or time outside the working days and hours.
const NOW = new Date("2026-01-02T12:00:00Z"); // a Friday
const withContact = (c: string) => workflowSettingsSchema.parse({ appointments: { workingDays: ["mon", "tue", "wed", "thu", "fri"], openTime: "09:00", closeTime: "17:00", outOfHoursContact: c } }).appointments;

test("the setting is optional: older saved settings without it still load, and it is empty by default", () => {
  assert.equal(DEFAULT_WORKFLOW_SETTINGS.appointments.outOfHoursContact, "");
  assert.equal(parseWorkflowSettings({ appointments: { openTime: "10:00" } }).appointments.outOfHoursContact, "");
});

test("the settings form passes the contact text through, trimmed, and caps it at 300 characters", () => {
  const input = formToWorkflowInput((n) => (n === "out_of_hours_contact" ? "  Call +91 98765 43210  " : n === "appointments_enabled" ? "on" : null));
  assert.equal(workflowSettingsSchema.parse(input).appointments.outOfHoursContact, "Call +91 98765 43210");
  assert.equal(workflowSettingsSchema.safeParse({ appointments: { outOfHoursContact: "x".repeat(301) } }).success, false);
});

test("cleanContact makes one safe line: no line breaks or control characters, never longer than 300", () => {
  assert.equal(cleanContact("Call 123\n\nor email a@b.com\u0007"), "Call 123 or email a@b.com");
  assert.equal(cleanContact(null), ""); assert.equal(cleanContact("x".repeat(500)).length, 300);
});

test("a request for a day you do not work gets the contact details in the SAME message", () => {
  const a = withContact("Call +91 98765 43210 or email hello@biz.com");
  const sat = appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "";
  assert.match(sat, /Saturday/); assert.match(sat, /You can also reach us at: Call \+91 98765 43210 or email hello@biz\.com\./);
});

test("a time outside the hours gets the contact details too", () => {
  const a = withContact("hello@biz.com");
  const late = appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "8pm" }, a, NOW) ?? "";
  assert.match(late, /09:00 to 17:00/); assert.match(late, /reach us at: hello@biz\.com\./);
});

test("with no contact set the messages are exactly as before, and an in-hours request passes", () => {
  const a = withContact("");
  assert.doesNotMatch(appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "", /reach us/);
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, withContact("hello@biz.com"), NOW), null);
});

test("the assistant's rules carry the contact details only when they are set, and only for out-of-hours requests", () => {
  assert.equal(outOfHoursNote(""), "");
  const note = outOfHoursNote("Call +91 98765 43210");
  assert.match(note, /outside the working days or hours/); assert.match(note, /Call \+91 98765 43210/); assert.match(note, /never any other phone number/);
  const set = workflowSettingsSchema.parse({ appointments: { outOfHoursContact: "Call +91 98765 43210" } });
  assert.match(renderWorkflowRules(set, null, "2026-01-02"), /Call \+91 98765 43210/);
  assert.doesNotMatch(renderWorkflowRules(DEFAULT_WORKFLOW_SETTINGS, null, "2026-01-02"), /share these contact details/);
});
