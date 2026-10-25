import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmSignupTemplate, emailLayout, escapeHtml } from "../lib/email/html";
import { classifySignups, type AuthUserRow } from "../lib/admin-signups";

test("escapeHtml neutralises markup and quotes", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'y'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
});

test("layout is branded, has a hidden preheader, and escapes every dynamic value", () => {
  const html = emailLayout({
    preheader: "<b>pre</b>", heading: "Hi <i>there</i>", paragraphs: ["a & b <script>x</script>"],
    details: [{ label: "Business", value: `"><img src=x onerror=alert(1)>` }],
    button: { label: "Go", url: "https://x.test/a?b=1&c=2" }, footer: "foot <u>",
  });
  assert.match(html, /AG Enterprises and Technologies/);
  assert.match(html, /bgcolor="#5b12a6"/);
  assert.match(html, /display:none!important/); // preheader hidden
  assert.doesNotMatch(html, /<script>|<img |<i>|<u>|<b>pre/); // none of the injected markup survives
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/x\.test\/a\?b=1&amp;c=2"/); // & escaped inside the attribute
  assert.match(html, /If the button doesn&#39;t work/);
});

test("layout without a button or footer still renders", () => {
  const html = emailLayout({ preheader: "p", heading: "H", paragraphs: ["only text"] });
  assert.match(html, /only text/);
  assert.doesNotMatch(html, /If the button/);
});

test("Supabase confirmation template keeps Supabase's placeholders intact", () => {
  const { subject, html } = confirmSignupTemplate();
  assert.match(subject, /Confirm your email/);
  // the button goes through OUR confirm page, using Supabase's token hash
  assert.match(html, /href="\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&amp;type=email"/);
  assert.doesNotMatch(html, /ConfirmationURL/);
  assert.match(html, /\{\{ \.Email \}\}/);
  assert.match(html, /Confirm my email/);
  assert.match(html, /AG Enterprises and Technologies/);
  assert.equal((html.match(/\{\{ \.TokenHash \}\}/g) ?? []).length, 3); // button href, fallback href, fallback text
});

// ---- admin sign-up list ----
const u = (over: Partial<AuthUserRow> & { id: string }): AuthUserRow => ({
  email: `${over.id}@x.co`, created_at: "2026-10-01T00:00:00Z", email_confirmed_at: "2026-10-01T00:05:00Z",
  app_metadata: {}, user_metadata: { business_name: "Biz " + over.id }, ...over,
});

test("admin list separates waiting from approved, hides admins, and shows verified people first", () => {
  const users = [
    u({ id: "unverified", email_confirmed_at: null, created_at: "2026-10-05T00:00:00Z" }),
    u({ id: "verified-old", created_at: "2026-10-02T00:00:00Z" }),
    u({ id: "verified-new", created_at: "2026-10-04T00:00:00Z" }),
    u({ id: "approved", app_metadata: { approved: true } }),
    u({ id: "owner" }), // linked to a business: counts as approved
    u({ id: "boss", app_metadata: { is_admin: true, approved: true } }),
  ];
  const { waiting, approved } = classifySignups(users, ["owner"]);
  assert.deepEqual(waiting.map((r) => r.id), ["verified-new", "verified-old", "unverified"]);
  assert.deepEqual(approved.map((r) => r.id).sort(), ["approved", "owner"]);
  assert.equal(approved.find((r) => r.id === "owner")?.hasBusiness, true);
  assert.equal(waiting.find((r) => r.id === "unverified")?.verified, false);
});

test("admin list tolerates missing fields and caps the approved list", () => {
  const rows = classifySignups([{ id: "a", app_metadata: null, user_metadata: null }], []);
  assert.deepEqual([rows.waiting[0].email, rows.waiting[0].business], ["(no email)", "(not given)"]);
  const many = Array.from({ length: 30 }, (_, i) => u({ id: `p${i}`, app_metadata: { approved: true } }));
  assert.equal(classifySignups(many, [], 20).approved.length, 20);
});

test("a flag that is not exactly true does not approve or make an admin", () => {
  const { waiting } = classifySignups([u({ id: "sneaky", app_metadata: { approved: "true", is_admin: "true" } })], []);
  assert.equal(waiting.length, 1);
});
