import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReply } from "../lib/ai/eval-checks";
import type { ReplyResult } from "../lib/ai/schema";

const r = (reply: string, over: Partial<ReplyResult> = {}): ReplyResult => ({
  reply, intent: "question", answered: true,
  contact: { name: null, email: null }, ...over,
});

test("passes when every expectation holds", () => {
  assert.deepEqual(checkReply(r("A cleaning is $60."), { answered: true, includes: ["$60"], excludes: ["$1"] }), []);
});
test("reports each kind of failure", () => {
  const p = checkReply(r("Probably $99", { intent: "other", answered: true }), {
    intent: "booking", answered: false, includes: ["60"], anyOf: ["team"], excludes: ["$99"],
  });
  assert.equal(p.length, 5); // intent, answered, includes, anyOf, excludes
});
test("matching ignores case and curly apostrophes", () => {
  assert.deepEqual(checkReply(r("I can’t share that."), { anyOf: ["CAN'T"] }), []);
});
