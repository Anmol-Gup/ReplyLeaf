import { test } from "node:test";
import assert from "node:assert/strict";
import { appointmentStatusMessage, appointmentUpdateSchema, APPOINTMENT_STATUSES, deliveryNotice, OWNER_STATUSES, scheduleNotice, STATUS_LABELS, validateSchedule, whatsappLink, whenText } from "../lib/appointments";
import { NOTICES } from "../lib/dashboard";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-20T10:00:00Z");

test("status names are short, and the owner picks from four of them", () => {
  assert.equal(STATUS_LABELS.pending, "Unconfirmed");
  assert.equal(STATUS_LABELS.confirmed, "Confirmed");
  assert.deepEqual([...OWNER_STATUSES], ["pending", "confirmed", "completed", "cancelled"]);
  for (const s of OWNER_STATUSES) assert.ok((APPOINTMENT_STATUSES as readonly string[]).includes(s));
  // older records may still carry other statuses and must stay valid
  for (const old of ["rejected", "reschedule_requested"]) assert.equal(appointmentUpdateSchema.safeParse({ id: ID, status: old, scheduled_date: "", scheduled_time: "", customer_email: "", notes: "" }).success, true);
});

test("the update form: any status, a date that is real or empty, a private note that is trimmed and capped", () => {
  const ok = appointmentUpdateSchema.parse({ id: ID, status: "confirmed", scheduled_date: "2026-11-25", scheduled_time: " 3pm ", customer_email: "", notes: "  called, agreed  " });
  assert.deepEqual([ok.status, ok.scheduled_date, ok.scheduled_time, ok.notes], ["confirmed", "2026-11-25", "3pm", "called, agreed"]);
  const base = { id: ID, status: "pending", scheduled_date: "", scheduled_time: "", customer_email: "", notes: "" };
  assert.equal(appointmentUpdateSchema.safeParse(base).success, true);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, status: "banana" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, scheduled_date: "2026-02-31" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, scheduled_date: "tomorrow" }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, notes: "x".repeat(2001) }).success, false);
  assert.equal(appointmentUpdateSchema.safeParse({ ...base, id: "nope" }).success, false);
});

test("the email is optional; when given it must be a real address, and an empty one clears it", () => {
  const base = { id: ID, status: "pending", scheduled_date: "", scheduled_time: "", notes: "" };
  assert.equal(appointmentUpdateSchema.parse({ ...base, customer_email: "" }).customer_email, "");
  assert.equal(appointmentUpdateSchema.parse({ ...base, customer_email: "  ravi@example.com " }).customer_email, "ravi@example.com");
  for (const bad of ["ravi", "ravi@", "@example.com", "ravi example.com", "a@b", "x".repeat(200) + "@example.com"]) assert.equal(appointmentUpdateSchema.safeParse({ ...base, customer_email: bad }).success, false, bad);
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
  assert.deepEqual(Object.keys(appointmentUpdateSchema.shape).sort(), ["customer_email", "id", "notes", "scheduled_date", "scheduled_time", "status"]);
});

test("a link to chat with the customer: digits only, unusable numbers give no link", () => {
  assert.equal(whatsappLink("+91 98000-00001"), "https://wa.me/919800000001");
  assert.equal(whatsappLink("919800000001", "Hi & hello"), "https://wa.me/919800000001?text=Hi%20%26%20hello");
  assert.equal(whatsappLink("12"), null);
  assert.equal(whatsappLink(null), null);
  assert.equal(whatsappLink("1".repeat(20)), null);
});

test("the appointment page sends the customer nothing by itself: a plain 'updated' notice stays, and telling them is opt-in", () => {
  assert.equal(NOTICES.appt_done.text, "Appointment updated.");
  assert.equal(NOTICES.appt_need_alternative, undefined); // the old guided buttons stay gone
  // the notify outcomes only exist for the opt-in tick box, and they say what really happened
  for (const c of ["whatsapp", "email", "failed", "none"] as const) assert.ok(NOTICES[deliveryNotice("appt", c)], c);
});

test("tickets still report what really happened when the customer was told", () => {
  assert.equal(deliveryNotice("tkt", "whatsapp"), "tkt_done_whatsapp");
  assert.equal(deliveryNotice("tkt", "email"), "tkt_done_email");
  assert.equal(deliveryNotice("tkt", "failed"), "tkt_done_failed");
  assert.equal(deliveryNotice("tkt", "none"), "tkt_done_not_sent");
  for (const c of ["whatsapp", "email", "failed", "none"] as const) assert.ok(NOTICES[deliveryNotice("tkt", c)], c);
  assert.equal(NOTICES.tkt_done_failed.kind, "error");
});

test("telling the customer about an appointment: every outcome has a notice, and the text is safe", () => {
  for (const c of ["whatsapp", "email", "failed", "none"] as const) assert.ok(NOTICES[deliveryNotice("appt", c)], c);
  assert.equal(deliveryNotice("appt", "none"), "appt_done_not_sent");
  assert.equal(NOTICES.appt_done_failed.kind, "error");
  assert.equal(NOTICES.appt_done_not_sent.kind, "warn");
  assert.match(NOTICES.appt_done_not_sent.text, /NOT told/);
  assert.ok(NOTICES.appt_nothing_to_notify);

  const confirmed = appointmentStatusMessage("AG Enterprises", "project status", "confirmed", "2026-11-30 11:00 AM", "See you then.");
  assert.match(confirmed, /^Update from AG Enterprises on your appointment request "project status": it is confirmed for 2026-11-30 11:00 AM\./);
  assert.match(confirmed, /See you then\./);
  assert.match(confirmed, /reply here/);
  // no time given: no dangling "for"
  assert.doesNotMatch(appointmentStatusMessage("Biz", "x", "confirmed", "", ""), / for \./);
  assert.match(appointmentStatusMessage("Biz", "x", "cancelled", "", ""), /cancelled/);
  assert.match(appointmentStatusMessage("Biz", "x", "completed", "", ""), /completed/);
  assert.match(appointmentStatusMessage("Biz", "x", "pending", "", ""), /waiting/);
  // the owner's line is trimmed to one line and capped; long purposes are capped too
  const long = appointmentStatusMessage("Biz", "p".repeat(500), "cancelled", "", `a\n\n  b ${"z".repeat(900)}`);
  assert.ok(!long.includes("\n"));
  assert.ok(long.length < 1000);
});
