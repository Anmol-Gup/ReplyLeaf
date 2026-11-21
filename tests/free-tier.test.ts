import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEligibility } from "../lib/wa-usage";

test("eligibility comes from Meta's reports, free tier wins, stored value is the fallback", () => {
  assert.equal(detectEligibility({}), "unknown");
  assert.equal(detectEligibility({ wa_free_tier_seen_at: "2026-11-01T00:00:00Z" }), "eligible");
  assert.equal(detectEligibility({ wa_paid_service_seen_at: "2026-11-01T00:00:00Z" }), "not_eligible");
  assert.equal(detectEligibility({ wa_free_tier_seen_at: "x", wa_paid_service_seen_at: "y" }), "eligible");
  assert.equal(detectEligibility({ wa_free_allowance: "not_eligible" }), "not_eligible");
});
