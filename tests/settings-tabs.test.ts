import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantSetup, parseTab, SETTINGS_TABS } from "../lib/settings-tabs";
import { DEFAULT_WORKFLOW_SETTINGS, formToWorkflowInput, parseWorkflowSettings } from "../lib/workflow-settings";

test("parseTab: known tabs pass, anything from the URL that is not a tab falls back", () => {
  for (const t of SETTINGS_TABS) assert.equal(parseTab(t.id), t.id);
  for (const bad of [undefined, "", "nope", "../x", "AI", ["ai"], 5]) assert.equal(parseTab(bad), "ai");
  assert.equal(parseTab("zzz", "workflows"), "workflows");
});

const base = { mode: "byok" as const, hasKey: true, keyStatus: "valid" as const, hasPhone: true, onboardingStatus: "connected", clientStatus: "active" };

test("assistantSetup: ready only when the AI key works and WhatsApp is connected", () => {
  assert.equal(assistantSetup(base).ready, true);
  assert.equal(assistantSetup({ ...base, hasKey: false, keyStatus: "none" }).firstTab, "ai");
  assert.equal(assistantSetup({ ...base, keyStatus: "invalid" }).steps[0].title, "Replace your AI key");
  assert.equal(assistantSetup({ ...base, keyStatus: "unverified" }).ready, true); // saved but not checked yet: it is tried
  assert.equal(assistantSetup({ ...base, mode: "platform", hasKey: false, keyStatus: "none" }).ready, true); // platform AI needs no key
  const noPhone = assistantSetup({ ...base, hasPhone: false, onboardingStatus: null });
  assert.equal(noPhone.ready, false); assert.equal(noPhone.firstTab, "whatsapp");
  assert.equal(assistantSetup({ ...base, onboardingStatus: "failed" }).steps[1].title, "Reconnect your WhatsApp number");
  assert.equal(assistantSetup({ ...base, onboardingStatus: "pending" }).ready, true); // waiting for Meta's confirmation does not block replies
});

test("assistantSetup: a paused account is reported, a failed connection is not double-reported", () => {
  const paused = assistantSetup({ ...base, clientStatus: "paused" });
  assert.equal(paused.ready, false);
  assert.ok(paused.steps.some((s) => s.id === "account" && !s.done));
  assert.ok(!assistantSetup({ ...base, onboardingStatus: "failed", clientStatus: "paused" }).steps.some((s) => s.id === "account"));
});

test("workflow settings: a disabled workflow keeps its saved fields when the form is submitted (hidden fields still post)", () => {
  // The form posts the hidden fields of a switched-off workflow; only its checkbox is missing.
  const posted: Record<string, string> = {
    support_categories: "Delivery\nBilling", support_response_time: "within 2 days", support_instructions: "ask for order number",
    services: "Websites\nApps", questions: "Timeline?", enquiry_instructions: "be brief",
    availability: "Mon-Fri 9-6", response_time: "1 day", escalation_instructions: "refunds",
    open_time: "10:00", close_time: "18:00", appointment_duration: "30", appointment_notice: "4", appointment_instructions: "new patient?", day_mon: "on", day_tue: "on",
  };
  const s = parseWorkflowSettings(formToWorkflowInput((n) => posted[n] ?? null));
  assert.equal(s.support.enabled, false); assert.deepEqual(s.support.categories, ["Delivery", "Billing"]); assert.equal(s.support.responseTime, "within 2 days");
  assert.equal(s.enquiries.enabled, false); assert.deepEqual(s.enquiries.services, ["Websites", "Apps"]);
  assert.equal(s.handoff.enabled, false); assert.equal(s.handoff.availability, "Mon-Fri 9-6");
  assert.equal(s.appointments.enabled, false); assert.equal(s.appointments.openTime, "10:00"); assert.equal(s.appointments.durationMinutes, 30);
  assert.deepEqual(s.appointments.workingDays, ["mon", "tue"]);
  assert.notDeepEqual(s, DEFAULT_WORKFLOW_SETTINGS);
});
