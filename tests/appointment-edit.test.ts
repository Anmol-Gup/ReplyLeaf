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

import { whatsappLink } from "../lib/appointments";

test("'Send from WhatsApp' link: digits only, the message is encoded, unusable numbers give no link", () => {
  assert.equal(whatsappLink("+91 98000-00001", "Hi there & welcome"), "https://wa.me/919800000001?text=Hi%20there%20%26%20welcome");
  assert.equal(whatsappLink("919800000001", "x"), "https://wa.me/919800000001?text=x");
  assert.equal(whatsappLink("12", "x"), null);
  assert.equal(whatsappLink(null, "x"), null);
  assert.equal(whatsappLink("1".repeat(20), "x"), null);
});

// ================= confirming, scheduling, time zones, notifications =================
import { customerMessage, deliveryNotice, nextStatus, scheduleNotice, validateSchedule, whenWithZone } from "../lib/appointments";
import { NOTICES } from "../lib/dashboard";

const NOW = new Date("2026-11-20T10:00:00Z");

test("confirming needs a real scheduled date and clock time", () => {
  assert.deepEqual(validateSchedule({ date: "2026-11-21", time: "10:30" }, { timeZone: null, now: NOW }), { ok: true, date: "2026-11-21", time: "10:30" });
  assert.deepEqual(validateSchedule({ date: "2026-11-21", time: "3pm" }, { timeZone: null, now: NOW }), { ok: true, date: "2026-11-21", time: "3pm" });
  for (const [f, problem] of [
    [{ date: "", time: "10am" }, "date"], [{ date: "2026-02-31", time: "10am" }, "date"], [{ date: "next friday", time: "10am" }, "date"], [{ date: undefined, time: "10am" }, "date"],
    [{ date: "2026-11-21", time: "" }, "time"], [{ date: "2026-11-21", time: "morning" }, "time"], [{ date: "2026-11-21", time: "25:00" }, "time"], [{ date: "2026-11-21", time: null }, "time"],
    [{ date: "2026-11-19", time: "10am" }, "past"],
  ] as const) {
    const r = validateSchedule(f, { timeZone: null, now: NOW });
    assert.equal(r.ok, false, JSON.stringify(f));
    if (!r.ok) { assert.equal(r.problem, problem, JSON.stringify(f)); assert.ok(NOTICES[scheduleNotice(r.problem)], "every problem has a message"); }
  }
});

test("'in the past' is judged in the appointment's time zone, and can be skipped when only editing an old record", () => {
  const lateUtc = new Date("2026-11-20T21:00:00Z");                    // 21 Nov 02:30 in Kolkata, still 20 Nov in New York
  assert.equal(validateSchedule({ date: "2026-11-20", time: "10am" }, { timeZone: "Asia/Kolkata", now: lateUtc }).ok, false);   // already yesterday there
  assert.equal(validateSchedule({ date: "2026-11-20", time: "10am" }, { timeZone: "America/New_York", now: lateUtc }).ok, true); // still today there
  assert.equal(validateSchedule({ date: "2026-11-01", time: "10am" }, { timeZone: null, now: NOW, checkPast: false }).ok, true);   // an old confirmed appointment can be edited
  assert.equal(validateSchedule({ date: "2026-11-01", time: "bad" }, { timeZone: null, now: NOW, checkPast: false }).ok, false);  // but a time must still be a time
});

test("times are shown and sent with the zone they are in; the customer's preference is untouched by it", () => {
  assert.equal(whenWithZone("2026-11-21", "11 am", "Asia/Kolkata"), "2026-11-21 11 am (Asia/Kolkata)");
  assert.equal(whenWithZone("2026-11-21", "11 am", null), "2026-11-21 11 am");
  assert.equal(whenWithZone(null, null, "Asia/Kolkata"), "");
  assert.match(customerMessage("confirm", { purpose: "call", when: whenWithZone("2026-11-21", "3pm", "Asia/Kolkata") }, "AG"), /confirmed for 2026-11-21 3pm \(Asia\/Kolkata\)/);
});

test("guided status transitions: only valid ones, and closed appointments have none", () => {
  assert.equal(nextStatus("pending", "confirm"), "confirmed");
  assert.equal(nextStatus("pending", "reject"), "rejected");
  assert.equal(nextStatus("pending", "reschedule"), "reschedule_requested");
  assert.equal(nextStatus("confirmed", "reschedule"), "reschedule_requested");
  assert.equal(nextStatus("confirmed", "cancel"), "cancelled");
  assert.equal(nextStatus("confirmed", "complete"), "completed");
  assert.equal(nextStatus("reschedule_requested", "confirm"), "confirmed");
  // not allowed
  assert.equal(nextStatus("confirmed", "confirm"), null);
  assert.equal(nextStatus("confirmed", "reject"), null);
  assert.equal(nextStatus("pending", "complete"), null);
  for (const closed of ["rejected", "cancelled", "completed"] as const) for (const a of ["confirm", "reject", "reschedule", "cancel", "complete"] as const) assert.equal(nextStatus(closed, a), null, `${closed} ${a}`);
});

test("customer messages never contain internal notes, whatever the status", () => {
  const secret = "INTERNAL: customer is difficult";
  for (const action of ["confirm", "reject", "reschedule", "cancel"] as const) {
    const m = customerMessage(action, { purpose: "call", when: "2026-11-21 3pm", note: "we are fully booked" }, "AG");
    assert.ok(!m.includes(secret) && !/internal/i.test(m), action);
  }
});

test("what really happened when the customer was told: sent, sent by email, failed, or not reachable", () => {
  assert.equal(deliveryNotice("appt", "whatsapp"), "appt_done_whatsapp");
  assert.equal(deliveryNotice("appt", "email"), "appt_done_email");
  assert.equal(deliveryNotice("appt", "failed"), "appt_done_failed");
  assert.equal(deliveryNotice("appt", "none"), "appt_done_not_sent");
  assert.equal(deliveryNotice("tkt", "failed"), "tkt_done_failed");
  for (const p of ["appt", "tkt"] as const) for (const c of ["whatsapp", "email", "failed", "none"] as const) assert.ok(NOTICES[deliveryNotice(p, c)], `${p} ${c} has a message`);
  assert.equal(NOTICES.appt_done_failed.kind, "error");                          // a failed send is shown as an error, never as sent
  assert.match(NOTICES.appt_done.text, /not told/i);                              // no notification requested: it says so
});
