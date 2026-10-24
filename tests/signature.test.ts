import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { safeEqual, verifySignature } from "../lib/whatsapp/signature";

const secret = "app-secret";
const body = new TextEncoder().encode('{"object":"whatsapp_business_account","note":"héllo \\u00e9"}');
const sign = (b: Uint8Array, s = secret) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");

test("accepts a valid signature over the raw bytes", () => {
  assert.equal(verifySignature(body, sign(body), secret), true);
});
test("rejects a tampered body", () => {
  const tampered = new TextEncoder().encode('{"object":"x"}');
  assert.equal(verifySignature(tampered, sign(body), secret), false);
});
test("rejects a signature made with the wrong secret", () => {
  assert.equal(verifySignature(body, sign(body, "other"), secret), false);
});
test("rejects missing, malformed, or wrong-length headers without throwing", () => {
  assert.equal(verifySignature(body, null, secret), false);
  assert.equal(verifySignature(body, "", secret), false);
  assert.equal(verifySignature(body, "sha1=abcd", secret), false);
  assert.equal(verifySignature(body, "sha256=abcd", secret), false);
  assert.equal(verifySignature(body, "sha256=not-hex!", secret), false);
});
test("safeEqual compares strings in constant time and handles length differences", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
