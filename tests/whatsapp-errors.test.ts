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
