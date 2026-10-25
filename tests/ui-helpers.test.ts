import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_NAME, privacyUrl, termsUrl } from "../lib/brand";
import { clip, fmtDay, fmtTime, matches, windowStatus } from "../lib/dashboard";

test("time and day formatting is UTC and tolerant of missing values", () => {
  assert.equal(fmtTime("2026-10-24T14:05:09Z"), "14:05");
  assert.equal(fmtDay("2026-10-24T14:05:09Z"), "24 Oct");
  assert.equal(fmtTime(null), "");
  assert.equal(fmtDay(undefined), "");
});

const NOW = new Date("2026-01-02T12:00:00Z");
test("window status is plain language, with time left while open", () => {
  assert.deepEqual(windowStatus("2026-01-02T06:48:00Z", NOW), { open: true, label: "Open: closes in 18h 48m" });
  assert.equal(windowStatus("2026-01-01T11:59:00Z", NOW).open, false); // just over 24h ago
  assert.match(windowStatus("2026-01-01T11:59:00Z", NOW).label, /^Closed/);
  assert.deepEqual([windowStatus(null, NOW).open, /not messaged/.test(windowStatus(null, NOW).label)], [false, true]);
});

test("window status agrees with the real send guard at the boundary", () => {
  // exactly 24h ago: closed in both (the guard uses < 24h)
  assert.equal(windowStatus("2026-01-01T12:00:00Z", NOW).open, false);
  assert.equal(windowStatus("2026-01-01T12:00:01Z", NOW).open, true);
});

test("list search matches any field, case-insensitively, and empty queries match everything", () => {
  assert.equal(matches("asha", "Asha K", "911"), true);
  assert.equal(matches("  ASHA ", null, "asha@x.co"), true);
  assert.equal(matches("zzz", "Asha", "911", null), false);
  assert.equal(matches("", "anything"), true);
  assert.equal(matches(undefined, "anything"), true);
});

test("clip shortens long text only", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("x".repeat(100), 10), "xxxxxxxxxx...");
  assert.equal(clip(null), "");
});

test("brand name and optional legal links", () => {
  assert.equal(COMPANY_NAME, "AG Enterprises and Technologies");
  const saved = { p: process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL, t: process.env.NEXT_PUBLIC_TERMS_URL };
  delete process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL; delete process.env.NEXT_PUBLIC_TERMS_URL;
  assert.equal(privacyUrl(), "/privacy");
  assert.equal(termsUrl(), "/terms");
  process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL = "https://example.com/privacy";
  assert.equal(privacyUrl(), "https://example.com/privacy");
  if (saved.p === undefined) delete process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL; else process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL = saved.p;
  if (saved.t !== undefined) process.env.NEXT_PUBLIC_TERMS_URL = saved.t;
});
