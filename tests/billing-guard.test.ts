import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-level guards for the rules that must hold in EVERY code path, not just the ones with a unit test.
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const body = (src: string, fn: string) => {
  const start = src.indexOf(`export async function ${fn}(`);
  assert.ok(start >= 0, `${fn} not found`);
  const next = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
};

test("14. every paid dashboard action checks the subscription on the server before doing anything", () => {
  const gated: [string, string[]][] = [
    ["app/dashboard/actions.ts", ["sendHumanMessage", "updateKnowledge", "createDocument", "publishDocumentAction", "setDocumentStatus", "restoreVersion", "reindexDocumentAction"]],
    ["app/dashboard/appointments/actions.ts", ["appointmentTransition"]],
    ["app/dashboard/tickets/actions.ts", ["updateTicket"]],
  ];
  for (const [file, fns] of gated) {
    const src = read(file);
    for (const fn of fns) {
      const b = body(src, fn);
      const at = b.indexOf("requirePaidAccess(");
      assert.ok(at > 0, `${file} ${fn} does not check the subscription`);
      // the check comes straight after the tenant is resolved and before any write or send
      const afterSignature = b.slice(b.indexOf("{\n") + 2); // skip the function's own name
      const firstEffect = afterSignature.search(/\.(insert|update|upsert|rpc)\(|sendClientText|notifyCustomer|extractText|publishDocument\(|reindexDocument\(/);
      assert.ok(firstEffect < 0 || afterSignature.indexOf("requirePaidAccess(") < firstEffect, `${file} ${fn} checks too late`);
    }
  }
});

test("actions that must stay available without a subscription do not require one (billing, export, viewing, privacy, settings)", () => {
  const actions = read("app/dashboard/actions.ts");
  for (const fn of ["logout", "deleteContact", "updateSettings", "updateContact", "takeOver", "handBack"]) {
    assert.ok(!body(actions, fn).includes("requirePaidAccess"), `${fn} must not be blocked`);
  }
  assert.ok(!read("app/dashboard/settings/actions.ts").includes("requirePaidAccess"), "settings, AI key and notifications stay editable");
  assert.ok(!read("app/api/account/export/route.ts").includes("requirePaidAccess"), "export is always available");
  assert.ok(!read("app/dashboard/billing/page.tsx").includes("requirePaidAccess"), "the billing page is always reachable");
});

test("16. the billing endpoints take the business from the signed-in session and never from the request", () => {
  for (const f of ["checkout", "portal", "cancel"]) {
    const src = read(`app/api/billing/${f}/route.ts`);
    assert.ok(src.includes("getClientOrNull()"), `${f} must resolve the tenant from the session`);
    assert.ok(!/req\.json\(\)|req\.formData\(\)|req\.text\(\)|searchParams/.test(src), `${f} must not read tenant data from the request`);
    assert.ok(src.includes("checkPost(req)"), `${f} must check JSON and origin`);
    assert.ok(src.includes("billingLimiter.allow"), `${f} must be rate limited`);
  }
  const sub = read("app/api/billing/subscription/route.ts");
  assert.ok(sub.includes("me.db") && !sub.includes("supabaseAdmin"), "the subscription endpoint reads through the owner's session (RLS)");
});

test("11. the webhook verifies the signature on the raw body BEFORE parsing anything, and answers 400 when it is wrong", () => {
  const src = read("app/api/billing/webhook/route.ts");
  const raw = src.indexOf("req.text()");
  const verify = src.indexOf("verifyStripeSignature(");
  const parse = src.indexOf("JSON.parse(");
  assert.ok(raw > 0 && verify > raw && parse > verify, "raw body -> verify -> parse");
  assert.match(src, /status: 400/);
  assert.ok(src.includes("status: 500"), "a processing failure answers 5xx so Stripe retries");
  for (const line of src.split("\n").filter((l) => /console\./.test(l))) {
    assert.ok(!/\braw\b|,\s*event\s*[,)]|event\.data/.test(line), `the payload must never be logged: ${line.trim()}`);
  }
});

test("15. background work is gated: the batch worker, the daily check; token refresh and retention deliberately still run", () => {
  assert.match(read("lib/batch.ts"), /!client\.billing\.allowed/);
  assert.match(read("lib/supabase-batch.ts"), /computeAccess\(/);
  assert.match(read("app/api/cron/daily-check/route.ts"), /paidClientIds/);
  assert.ok(!read("app/api/cron/retention/route.ts").includes("billing"), "data retention must run for everyone");
});

test("no Stripe secret or webhook secret reaches browser code", () => {
  for (const f of ["components/BillingButtons.tsx", "components/BillingButtons.tsx", "app/dashboard/BillingBanner.tsx"]) {
    const src = read(f);
    assert.ok(!/STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|process\.env/.test(src), `${f} must not touch secrets`);
  }
  assert.ok(!/NEXT_PUBLIC_STRIPE/.test(read(".env.example")), "no secret in a NEXT_PUBLIC variable");
});
