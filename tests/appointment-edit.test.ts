import { test } from "node:test";
import assert from "node:assert/strict";
import { appointmentUpdateSchema, APPOINTMENT_STATUSES, deliveryNotice, OWNER_STATUSES, scheduleNotice, STATUS_LABELS, validateSchedule, whatsappLink, whenText } from "../lib/appointments";
import { NOTICES } from "../lib/dashboard";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-20T10:00:00Z");

test("status names are short, and the owner picks from four of them", () => {
  assert.equal(STATUS_LABELS.pending, "Unconfirmed");
  assert.equal(STATUS_LABELS.confirmed, "Confirmed");
  assert.deepEqual([...OWNER_STATUSES], ["pending", "confirmed", "completed", "cancelled"]);
  for (const s of OWNER_STATUSES) assert.ok((APPOINTMENT_STATUSES as readonly string[]).includes(s));
  // older records may still carry other statuses and must stay valid
  for (const old of ["rejected", "reschedule_requested"]) assert.equal(appointmentUpdateSchema.safeParse({ id: ID, status: old, scheduled_date: "", scheduled_time: "", notes: "" }).success, true);
});

test("the update form: any status, a date that is real or empty, a private note that is trimmed and capped", () => {
  const ok = appointmentUpdateSchema.parse({ id: ID, status: "confirmed", scheduled_date: "2026-11-25", scheduled_time: " 3pm ", notes: "  called, agreed  " });
  assert.deepEqual([ok.status, ok.scheduled_date, ok.scheduled_time, ok.notes], ["confirmed", "2026-11-25", "3pm", "called, agreed"]);
  const base = { id: ID, status: "pending", scheduled_date: "", scheduled_time: "", notes: "" };
  assert.equal(appointmentUpdateSchema.safeParse(base).success, true);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, status: "banana" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, scheduled_date: "2026-02-31" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, scheduled_date: "tomorrow" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, notes: "x".repeat(2001) }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, id: "nope" }).success, false);
});

test("confirming needs the agreed date and a real clock time", () => {
  assert.deepEqual(validateSchedule({ date: "2026-11-21", time: "10:30" }, { timeZone: null, now: NOW }), { ok: true, date: "2026-11-21", time: "10:30" });
  assert.equal(validateSchedule({ date: "2026-11-21", time: "3pm" }, { timeZone: null, now: NOW }).ok, true);
  for (const [f, problem] of [
    [{ date: "", time: "10am" }, "date"], [{ date: "2026-02-31", time: "10am" }, "date"], [{ date: "next friday", time: "10am" }, "date"],
    [{ date: "2026-11-21", time: "" }, "time"], [{ date: "2026-11-21", time: "morning" }, "time"], [{ date: "2026-11-21", time: "25:00" }, "time"],
    [{ date: "2026-11-19", time: "10am" }, "past"],
  ] as const) {
    const r = validateSchedule(f, { timeZone: null, now: NOW });
    assert.equal(r.ok, false, JSON.stringify(f));
    if (!r.ok) { assert.equal(r.problem, problem, JSON.stringify(f)); assert.ok(NOTICES[scheduleNotice(r.problem)], "every problem has a message"); }
  }
});

test("'in the past' follows the business time zone, and is skipped when only editing an old confirmed record", () => {
  const lateUtc = new Date("2026-11-20T21:00:00Z");   // 21 Nov 02:30 in Kolkata, still 20 Nov in New York
  assert.equal(validateSchedule({ date: "2026-11-20", time: "10am" }, { timeZone: "Asia/Kolkata", now: lateUtc }).ok, false);
  assert.equal(validateSchedule({ date: "2026-11-20", time: "10am" }, { timeZone: "America/New_York", now: lateUtc }).ok, true);
  assert.equal(validateSchedule({ date: "2026-11-01", time: "10am" }, { timeZone: null, now: NOW, checkPast: false }).ok, true);
  assert.equal(validateSchedule({ date: "2026-11-01", time: "bad" }, { timeZone: null, now: NOW, checkPast: false }).ok, false);
});

test("the customer's preferred date and time are separate from the agreed ones", () => {
  assert.equal(whenText("2026-11-21", "11 am"), "2026-11-21 11 am");
  assert.equal(whenText(null, "11 am"), "11 am");
  assert.equal(whenText(null, null), "");
  // the update schema has no field for the preferred date or time at all, so an update cannot overwrite what the customer asked for
  assert.deepEqual(Object.keys(appointmentUpdateSchema.shape).sort(), ["id", "notes", "scheduled_date", "scheduled_time", "status"]);
});

test("a link to chat with the customer: digits only, unusable numbers give no link", () => {
  assert.equal(whatsappLink("+91 98000-00001"), "https://wa.me/919800000001");
  assert.equal(whatsappLink("919800000001", "Hi & hello"), "https://wa.me/919800000001?text=Hi%20%26%20hello");
  assert.equal(whatsappLink("12"), null);
  assert.equal(whatsappLink(null), null);
  assert.equal(whatsappLink("1".repeat(20)), null);
});

test("the appointment page sends the customer nothing: only a plain 'updated' notice remains", () => {
  assert.equal(NOTICES.appt_done.text, "Appointment updated.");
  for (const gone of ["appt_done_whatsapp", "appt_done_email", "appt_done_not_sent", "appt_done_failed", "appt_need_alternative"]) assert.equal(NOTICES[gone], undefined, gone);
});

test("tickets still report what really happened when the customer was told", () => {
  assert.equal(deliveryNotice("tkt", "whatsapp"), "tkt_done_whatsapp");
  assert.equal(deliveryNotice("tkt", "email"), "tkt_done_email");
  assert.equal(deliveryNotice("tkt", "failed"), "tkt_done_failed");
  assert.equal(deliveryNotice("tkt", "none"), "tkt_done_not_sent");
  for (const c of ["whatsapp", "email", "failed", "none"] as const) assert.ok(NOTICES[deliveryNotice("tkt", c)], c);
  assert.equal(NOTICES.tkt_done_failed.kind, "error");
});
