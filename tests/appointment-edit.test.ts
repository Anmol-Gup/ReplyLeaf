import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedActions, appointmentEditSchema, APPOINTMENT_STATUSES, STATUS_LABELS, statusMessageAction } from "../lib/appointments";

const base = {
  id: "11111111-1111-4111-8111-111111111111", status: "pending", customer_name: "  Ravi ", purpose: " Discovery call ", preferred_date: "2026-11-21", preferred_time: " 11 am ",
  scheduled_date: "", scheduled_time: "", appointment_type: "", timezone: "", note: "", notify: false,
};

test("status names are short: Unconfirmed and Reschedule", () => {
  assert.equal(STATUS_LABELS.pending, "Unconfirmed");
  assert.equal(STATUS_LABELS.reschedule_requested, "Reschedule");
  assert.equal(STATUS_LABELS.confirmed, "Confirmed");
});

test("the edit form accepts any status, trims text, and rejects bad dates, unknown statuses and an empty purpose", () => {
  for (const status of APPOINTMENT_STATUSES) assert.equal(appointmentEditSchema.safeParse({ ...base, status }).success, true, status);
  const ok = appointmentEditSchema.parse(base);
  assert.deepEqual([ok.customer_name, ok.purpose, ok.preferred_time], ["Ravi", "Discovery call", "11 am"]);
  assert.equal(appointmentEditSchema.safeParse({ ...base, status: "banana" }).success, false);
  assert.equal(appointmentEditSchema.safeParse({ ...base, purpose: "   " }).success, false);
  assert.equal(appointmentEditSchema.safeParse({ ...base, preferred_date: "2026-02-31" }).success, false);
  assert.equal(appointmentEditSchema.safeParse({ ...base, scheduled_date: "tomorrow" }).success, false);
  assert.equal(appointmentEditSchema.safeParse({ ...base, appointment_type: "teleport" }).success, false);
  assert.equal(appointmentEditSchema.safeParse({ ...base, id: "nope" }).success, false);
});

test("manual status edits can reopen a closed appointment, which the guided buttons never could", () => {
  for (const closed of ["rejected", "cancelled", "completed"] as const) assert.deepEqual(allowedActions(closed), []); // guided buttons: nothing
  assert.equal(appointmentEditSchema.safeParse({ ...base, status: "pending" }).success, true);                         // but the editor can set it back to Unconfirmed
});

test("only confirmed, rejected, reschedule and cancelled have a customer message; unconfirmed and completed send nothing", () => {
  assert.equal(statusMessageAction("confirmed"), "confirm");
  assert.equal(statusMessageAction("rejected"), "reject");
  assert.equal(statusMessageAction("reschedule_requested"), "reschedule");
  assert.equal(statusMessageAction("cancelled"), "cancel");
  assert.equal(statusMessageAction("pending"), null);
  assert.equal(statusMessageAction("completed"), null);
});
