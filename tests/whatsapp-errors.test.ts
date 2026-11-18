import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWhatsAppError, isBlockingProblem } from "../lib/whatsapp/errors";

test("Meta error codes map to the right kind of problem", () => {
  assert.equal(classifyWhatsAppError(131042, "x"), "billing");
  assert.equal(classifyWhatsAppError(190, "x"), "permission");
  assert.equal(classifyWhatsAppError(131031, "x"), "account");
  assert.equal(classifyWhatsAppError(131047, "x"), "window");
  assert.equal(classifyWhatsAppError(130429, "x"), "rate_limit");
  assert.equal(classifyWhatsAppError(131049, "x"), "policy");
  assert.equal(classifyWhatsAppError(999999, "something odd"), "delivery");
});

test("without a known code the wording decides; billing wording is billing", () => {
  assert.equal(classifyWhatsAppError(null, "Business eligibility payment issue"), "billing");
  assert.equal(classifyWhatsAppError(undefined, "There is a problem with your credit line"), "billing");
  assert.equal(classifyWhatsAppError(null, "Error validating access token: Session has expired"), "permission");
  assert.equal(classifyWhatsAppError(null, "Message failed: re-engagement message outside the 24 hour window"), "window");
  assert.equal(classifyWhatsAppError(null, "boom"), "delivery");
});

test("only billing, account, permission and policy problems are 'blocking' (never retried)", () => {
  for (const p of ["billing", "account", "permission", "policy"] as const) assert.equal(isBlockingProblem(p), true, p);
  for (const p of ["window", "rate_limit", "delivery"] as const) assert.equal(isBlockingProblem(p), false, p);
});

// ---- controlled retries
import { isTemporaryApiError, sendTextMessageWithRetry, WhatsAppApiError } from "../lib/whatsapp/send";

const opts = { graphVersion: "v26.0", phoneNumberId: "1", accessToken: "tok", to: "919800000001", body: "hi" };
function stubFetch(responses: { status: number; json: unknown }[]) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { const r = responses[Math.min(calls++, responses.length - 1)]; return new Response(JSON.stringify(r.json), { status: r.status }); }) as typeof fetch;
  return { calls: () => calls, restore: () => { globalThis.fetch = real; } };
}
const ok = { status: 200, json: { messages: [{ id: "wamid.ok" }] } };

test("a temporary refusal (rate limit / service unavailable) is retried with backoff and then succeeds, once", async () => {
  const f = stubFetch([{ status: 429, json: { error: { code: 130429, message: "rate" } } }, { status: 503, json: { error: { message: "down" } } }, ok]);
  const waits: number[] = [];
  try {
    assert.deepEqual(await sendTextMessageWithRetry(opts, { sleep: async (ms) => void waits.push(ms) }), { waMessageId: "wamid.ok" });
    assert.equal(f.calls(), 3); assert.deepEqual(waits, [1000, 2000]);
  } finally { f.restore(); }
});

test("temporary failures stop after 3 attempts; billing and other refusals are never retried", async () => {
  const down = stubFetch([{ status: 503, json: { error: { message: "down" } } }]);
  try { await assert.rejects(sendTextMessageWithRetry(opts, { sleep: async () => {} }), (e: unknown) => e instanceof WhatsAppApiError); assert.equal(down.calls(), 3); } finally { down.restore(); }
  const billing = stubFetch([{ status: 400, json: { error: { code: 131042, message: "payment issue" } } }]);
  try { await assert.rejects(sendTextMessageWithRetry(opts, { sleep: async () => {} }), (e: unknown) => e instanceof WhatsAppApiError && e.code === 131042); assert.equal(billing.calls(), 1); } finally { billing.restore(); }
  assert.equal(isTemporaryApiError(new WhatsAppApiError("x", 500, 131000)), false);   // an unexplained 500 might have been accepted: no retry
  assert.equal(isTemporaryApiError(new Error("timeout")), false);                     // a timeout might have been sent: no retry, no duplicate
  assert.equal(isTemporaryApiError(new WhatsAppApiError("x", 400, 130429)), true);
});
