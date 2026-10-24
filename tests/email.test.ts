import { test } from "node:test";
import assert from "node:assert/strict";
import { oneLine } from "../lib/email/mailer";
import { adminAlertEmail, ownerEmail } from "../lib/email/templates";

const o = { to: "owner@example.com", businessName: "Bright Smile", appUrl: "https://app.example.com/" };

test("oneLine removes line breaks so customer text cannot inject headers", () => {
  assert.equal(oneLine("hi\r\nBcc: evil@example.com"), "hi Bcc: evil@example.com");
  assert.ok(oneLine("x".repeat(500)).length <= 150);
});

test("new lead email", () => {
  const m = ownerEmail({ type: "new_lead", contactName: "Asha", phone: "911", firstMessage: "hello" }, o);
  assert.equal(m.to, "owner@example.com");
  assert.match(m.subject, /New lead: Asha \(\+911\)/);
  assert.match(m.text, /https:\/\/app\.example\.com\/dashboard/);
});

test("booking email says REQUEST, includes the details, and never claims confirmation", () => {
  const m = ownerEmail({ type: "new_booking", contactName: null, phone: "911", service: "cleaning", preferredTime: "Fri 10am", bookingName: "Asha" }, o);
  assert.match(m.text, /REQUEST \(not confirmed yet\)/);
  assert.match(m.text, /cleaning/);
  assert.match(m.text, /Fri 10am/);
  assert.match(m.subject, /^New booking request/);
});

test("needs-human email explains why", () => {
  assert.match(ownerEmail({ type: "needs_human", contactName: null, phone: "9", reason: "failed_answers", lastMessage: "?" }, o).text, /could not answer twice/);
  assert.match(ownerEmail({ type: "needs_human", contactName: null, phone: "9", reason: "customer_request_or_upset", lastMessage: "?" }, o).text, /asked for a person/);
});

test("customer-controlled text cannot add lines to the subject", () => {
  const m = ownerEmail({ type: "new_lead", contactName: "Eve\nBcc: x@y.z", phone: "1", firstMessage: "a" }, o);
  assert.ok(!m.subject.includes("\n"));
});

test("long customer messages are clipped in the body", () => {
  const m = ownerEmail({ type: "new_lead", contactName: null, phone: "1", firstMessage: "z".repeat(5000) }, o);
  assert.ok(m.text.length < 1200);
});

test("admin alert email", () => {
  const m = adminAlertEmail({ to: "admin@example.com", kind: "batch_processing_failed", detail: "boom", clientName: "Bright Smile" });
  assert.match(m.subject, /batch_processing_failed \(Bright Smile\)/);
  assert.match(m.text, /boom/);
});
