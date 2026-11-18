import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_SERVICE_MESSAGES, monthBounds, serviceUsage } from "../lib/wa-usage";

test("the first 1,000 delivered service messages a month are free, the rest are paid", () => {
  assert.equal(FREE_SERVICE_MESSAGES, 1000);
  assert.deepEqual(serviceUsage(0), { delivered: 0, freeUsed: 0, freeRemaining: 1000, paid: 0 });
  assert.deepEqual(serviceUsage(250), { delivered: 250, freeUsed: 250, freeRemaining: 750, paid: 0 });
  assert.deepEqual(serviceUsage(1000), { delivered: 1000, freeUsed: 1000, freeRemaining: 0, paid: 0 });
  assert.deepEqual(serviceUsage(1342), { delivered: 1342, freeUsed: 1000, freeRemaining: 0, paid: 342 });
  assert.deepEqual(serviceUsage(-5), { delivered: 0, freeUsed: 0, freeRemaining: 1000, paid: 0 });
});

test("the month starts and resets at midnight in the business's time zone (UTC when none is set)", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  assert.deepEqual(monthBounds(now, null), { start: new Date("2026-11-01T00:00:00Z"), next: new Date("2026-12-01T00:00:00Z") });
  assert.deepEqual(monthBounds(now, "Asia/Kolkata"), { start: new Date("2026-10-31T18:30:00Z"), next: new Date("2026-11-30T18:30:00Z") });
  assert.deepEqual(monthBounds(now, "America/New_York"), { start: new Date("2026-11-01T04:00:00Z"), next: new Date("2026-12-01T05:00:00Z") }); // daylight saving ended on 1 Nov
  // 23:30 UTC on 30 Nov is already December in Kolkata
  assert.equal(monthBounds(new Date("2026-11-30T23:30:00Z"), "Asia/Kolkata").start.toISOString(), "2026-11-30T18:30:00.000Z");
  assert.equal(monthBounds(new Date("2026-12-15T00:00:00Z"), "Asia/Kolkata").next.toISOString(), "2026-12-31T18:30:00.000Z"); // December rolls into January
  assert.equal(monthBounds(now, "Not/AZone").start.toISOString(), "2026-11-01T00:00:00.000Z"); // a bad stored zone never throws
});

import { BILLING_STATUS_UNAVAILABLE, messageCategory, summariseUsage, type UsageRow } from "../lib/wa-usage";

const row = (phone: string | null, category: string, delivered: number, extra: Partial<UsageRow> = {}): UsageRow =>
  ({ out_phone_number_id: phone, out_category: category, out_total: delivered, out_delivered: delivered, out_failed: 0, out_awaiting: 0, ...extra });

test("usage: free used, remaining and chargeable follow the formulas exactly", () => {
  const [u] = summariseUsage([row("P1", "service", 750)], "eligible");
  assert.deepEqual([u.deliveredService, u.freeAllowance, u.freeUsed, u.freeRemaining, u.chargeableService, u.state, u.percentUsed], [750, 1000, 750, 250, 0, "ok", 75]);
  const [near] = summariseUsage([row("P1", "service", 800)], "eligible");
  assert.equal(near.state, "near");                                         // 80% used: a neutral warning
  const [full] = summariseUsage([row("P1", "service", 1000)], "eligible");
  assert.deepEqual([full.freeRemaining, full.chargeableService, full.state], [0, 0, "exhausted"]);
  const [over] = summariseUsage([row("P1", "service", 1342)], "eligible");
  assert.deepEqual([over.freeUsed, over.freeRemaining, over.chargeableService, over.percentUsed], [1000, 0, 342, 100]);
});

test("usage: marketing, utility and authentication are their own categories and never use the free service allowance", () => {
  const [u] = summariseUsage([row("P1", "service", 10), row("P1", "marketing", 5), row("P1", "utility", 7), row("P1", "authentication", 3), row("P1", "unknown", 2)], "eligible");
  assert.deepEqual([u.deliveredService, u.marketing, u.utility, u.authentication, u.unclassified, u.freeUsed], [10, 5, 7, 3, 2, 10]);
});

test("usage: failed and awaiting messages are never counted as delivered", () => {
  const [u] = summariseUsage([row("P1", "service", 4, { out_total: 9, out_failed: 3, out_awaiting: 2 })], "eligible");
  assert.deepEqual([u.totalOutgoing, u.deliveredService, u.failed, u.awaiting, u.freeRemaining], [9, 4, 3, 2, 996]);
});

test("usage: every phone number is counted separately", () => {
  const out = summariseUsage([row("P1", "service", 900), row("P2", "service", 100), row("P2", "utility", 1)], "eligible");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => [p.phoneNumberId, p.deliveredService, p.freeRemaining]), [["P1", 900, 100], ["P2", 100, 900]]);
});

test("usage: eligibility is honest. Not eligible means no free allowance at all; unknown keeps the estimate but is marked unknown", () => {
  const [no] = summariseUsage([row("P1", "service", 50)], "not_eligible");
  assert.deepEqual([no.freeAllowance, no.freeUsed, no.freeRemaining, no.chargeableService, no.state], [0, 0, 0, 50, "not_applicable"]);
  const [unknown] = summariseUsage([row("P1", "service", 50)], "unknown");
  assert.equal(unknown.eligibility, "unknown");
  assert.equal(unknown.freeRemaining, 950);
  assert.deepEqual(summariseUsage([], "eligible"), []);                      // nothing sent yet
  assert.equal(summariseUsage([row("P1", "service", "12" as unknown as number)], "eligible")[0].deliveredService, 12); // Postgres bigints arrive as strings
});

test("message category comes from how it was sent, never from its text", () => {
  assert.equal(messageCategory({ type: "text" }), "service");
  assert.equal(messageCategory({ type: "text", templateCategory: "marketing" }), "service");        // text that merely sounds promotional is still a service reply
  assert.equal(messageCategory({ type: "template", templateCategory: "Marketing" }), "marketing");
  assert.equal(messageCategory({ type: "template", templateCategory: "UTILITY" }), "utility");
  assert.equal(messageCategory({ type: "template", templateCategory: "authentication" }), "authentication");
  assert.equal(messageCategory({ type: "template" }), "unknown");                                   // a template with no known category is not guessed
  assert.equal(messageCategory({ type: "template", templateCategory: "whatever" }), "unknown");
});

test("Replyleaf cannot see Meta payment status and says so", () => {
  assert.equal(BILLING_STATUS_UNAVAILABLE, "Billing status unavailable");
});
