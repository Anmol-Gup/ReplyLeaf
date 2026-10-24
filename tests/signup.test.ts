import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedEmail, pendingUserEmail, signupNotificationEmail } from "../lib/email/templates";
import { hasApprovedFlag, isApproved, isExistingAccount, signupMode, signupSchema } from "../lib/signup";

test("signup mode defaults to approval and never falls back to open by accident", () => {
  assert.equal(signupMode(undefined), "approval");
  assert.equal(signupMode(""), "approval");
  assert.equal(signupMode("APPROVAL"), "approval");
  assert.equal(signupMode("open"), "open");
  assert.equal(signupMode(" Open "), "open");
  assert.equal(signupMode("off"), "off");
  assert.equal(signupMode("opne"), "approval"); // a typo must not open sign-up
  assert.equal(signupMode("true"), "approval");
});

test("approved flag must be exactly true", () => {
  assert.equal(hasApprovedFlag({ app_metadata: { approved: true } }), true);
  assert.equal(hasApprovedFlag({ app_metadata: { approved: "true" } }), false);
  assert.equal(hasApprovedFlag({ app_metadata: { approved: 1 } }), false);
  assert.equal(hasApprovedFlag({ app_metadata: {} }), false);
  assert.equal(hasApprovedFlag({ app_metadata: null }), false);
  assert.equal(hasApprovedFlag({}), false);
});

test("approval rules: flag, business membership, or open mode", () => {
  const none = {};
  const flagged = { app_metadata: { approved: true } };
  // approval mode
  assert.equal(isApproved(none, { mode: "approval", hasMembership: false }), false);
  assert.equal(isApproved(flagged, { mode: "approval", hasMembership: false }), true);
  assert.equal(isApproved(none, { mode: "approval", hasMembership: true }), true); // existing owners keep access
  // open mode lets everyone in
  assert.equal(isApproved(none, { mode: "open", hasMembership: false }), true);
  // off mode does NOT approve unapproved accounts
  assert.equal(isApproved(none, { mode: "off", hasMembership: false }), false);
  assert.equal(isApproved(flagged, { mode: "off", hasMembership: false }), true);
});

const valid = { email: "  Owner@Example.COM ", password: "a-long-enough-password", business: "  Bright Smile  " };

test("sign-up input is trimmed and the email lower-cased", () => {
  const r = signupSchema.safeParse(valid);
  assert.ok(r.success);
  assert.deepEqual([r.data.email, r.data.business], ["owner@example.com", "Bright Smile"]);
});

test("sign-up rejects short or over-long passwords with a distinct reason, and bad emails", () => {
  const short = signupSchema.safeParse({ ...valid, password: "short" });
  assert.ok(!short.success && short.error.issues.some((i) => i.message === "password_short"));
  const long = signupSchema.safeParse({ ...valid, password: "x".repeat(73) });
  assert.ok(!long.success && long.error.issues.some((i) => i.message === "password_long"));
  assert.ok(!signupSchema.safeParse({ ...valid, email: "not-an-email" }).success);
  assert.ok(!signupSchema.safeParse({ ...valid, business: "   " }).success);
  assert.ok(!signupSchema.safeParse({ ...valid, business: "x".repeat(101) }).success);
});

test("the honeypot field must stay empty", () => {
  assert.ok(signupSchema.safeParse({ ...valid, website: "" }).success);
  assert.ok(!signupSchema.safeParse({ ...valid, website: "http://spam.example" }).success);
});

test("admin sign-up email links to the approval page and keeps header text on one line", () => {
  const m = signupNotificationEmail({ to: "admin@x.co", email: "owner@example.com", business: "Bright Smile\nBcc: evil@x.co", appUrl: "https://app.example.com/" });
  assert.ok(!m.subject.includes("\n"));
  assert.match(m.text, /https:\/\/app\.example\.com\/admin\/signups/);
  assert.match(m.text, /npm run approve-user -- owner@example\.com/);
  assert.match(m.html ?? "", /href="https:\/\/app\.example\.com\/admin\/signups"/);
  assert.match(m.html ?? "", /Review and approve/);
});

test("without APP_URL the admin email falls back to the terminal command", () => {
  const m = signupNotificationEmail({ to: "a@x.co", email: "o@e.com", business: "B" });
  assert.doesNotMatch(m.html ?? "", /<a href=/);
  assert.match(m.html ?? "", /npm run approve-user -- o@e\.com/);
});

test("the waiting-list email to the user is a separate, friendly HTML email", () => {
  const m = pendingUserEmail({ to: "o@e.com", business: "Bright Smile" });
  assert.equal(m.to, "o@e.com");
  assert.match(m.subject, /on the list/i);
  assert.match(m.html ?? "", /You&#39;re on the list/);
  assert.match(m.html ?? "", /Bright Smile/);
  assert.match(m.text, /waiting list/);
});

test("approval email links to the sign-in page, in HTML and text", () => {
  const m = approvedEmail({ to: "o@e.com", appUrl: "https://app.example.com/" });
  assert.match(m.text, /https:\/\/app\.example\.com\/login/);
  assert.match(m.html ?? "", /href="https:\/\/app\.example\.com\/login"/);
  assert.doesNotMatch(approvedEmail({ to: "o@e.com" }).text, /Sign in:/);
});

test("existing accounts are detected in both Supabase modes, and new ones are not", () => {
  // Confirm email ON: success with an EMPTY identities list means "already registered"
  assert.equal(isExistingAccount({ user: { identities: [] } }, null), true);
  // a genuinely new account has an identity
  assert.equal(isExistingAccount({ user: { identities: [{}] } }, null), false);
  // Confirm email OFF: an explicit error
  assert.equal(isExistingAccount(null, { code: "user_already_exists" }), true);
  assert.equal(isExistingAccount(null, { code: "email_exists" }), true);
  // other errors are not "exists"
  assert.equal(isExistingAccount(null, { code: "over_request_rate_limit" }), false);
  assert.equal(isExistingAccount(null, {}), false);
  // missing data is not treated as existing
  assert.equal(isExistingAccount({ user: null }, null), false);
  assert.equal(isExistingAccount({ user: {} }, null), false);
  assert.equal(isExistingAccount(undefined, null), false);
});
