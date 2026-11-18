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
