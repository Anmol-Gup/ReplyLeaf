import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword } from "../lib/admin-password";

test("generated passwords have the requested length, avoid look-alike characters, and differ every time", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20);
    assert.doesNotMatch(p, /[0OIl1]/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  assert.equal(generatePassword(32).length, 32);
});

test("passwords shorter than 12 are refused", () => {
  assert.throws(() => generatePassword(11));
  assert.doesNotThrow(() => generatePassword(12));
});
