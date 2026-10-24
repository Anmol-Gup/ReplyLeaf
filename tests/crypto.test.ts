import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../lib/crypto";

const key = randomBytes(32).toString("base64");

test("round-trips and never stores plaintext", () => {
  const enc = encryptSecret("EAAG-secret-token", key);
  assert.ok(!enc.includes("EAAG"));
  assert.equal(decryptSecret(enc, key), "EAAG-secret-token");
});
test("uses a fresh IV each time", () => {
  assert.notEqual(encryptSecret("same", key), encryptSecret("same", key));
});
test("fails with the wrong key or tampered data", () => {
  const enc = encryptSecret("x", key);
  assert.throws(() => decryptSecret(enc, randomBytes(32).toString("base64")));
  const parts = enc.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join("."), key));
});
test("rejects a key that is not 32 bytes", () => {
  assert.throws(() => encryptSecret("x", Buffer.from("short").toString("base64")));
});
