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

test("needs-human email explains why", () => {
  assert.match(ownerEmail({ type: "needs_human", contactName: null, phone: "9", reason: "failed_answers", lastMessage: "?", summary: "s" }, o).text, /could not answer twice/);
  assert.match(ownerEmail({ type: "needs_human", contactName: null, phone: "9", reason: "customer_request", lastMessage: "?", summary: "s" }, o).text, /asked for a person/);
  assert.match(ownerEmail({ type: "needs_human", contactName: null, phone: "9", reason: "booking_without_link", lastMessage: "?", summary: "s" }, o).text, /no booking link is set/);
});

test("needs-human email carries the summary, the customer's last message and the handoff page link", () => {
  const m = ownerEmail({ type: "needs_human", contactName: "Asha", phone: "911", reason: "customer_request", lastMessage: "call me", summary: "Wants a refund." }, o);
  assert.match(m.text, /Summary: Wants a refund\./);
  assert.match(m.text, /last message: call me/);
  assert.match(m.text, /https:\/\/app\.example\.com\/dashboard\/handoff/);
  assert.match(m.text, /Next step/);
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

test("needs-human email links straight to the conversation, once per handoff", () => {
  const e = { type: "needs_human" as const, conversationId: "11111111-1111-1111-1111-111111111111", contactName: "Surya", phone: "9", reason: "customer_request" as const, lastMessage: "hi", summary: "wants a quote" };
  const t = ownerEmail(e, { to: "o@x.com", businessName: "B", appUrl: "https://app.example.com/" }).text;
  assert.match(t, /https:\/\/app\.example\.com\/dashboard\/conversations\/11111111-1111-1111-1111-111111111111/);
  assert.match(t, /wants a quote/);
});
