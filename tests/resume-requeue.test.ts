import { test } from "node:test";
import assert from "node:assert/strict";
import { unansweredCustomerIds } from "../lib/resume-requeue";

const m = (id: string, direction: "inbound" | "outbound") => ({ id, direction });

test("after resuming, the customer messages nobody has answered yet are the ones that come back", () => {
  // newest first: the customer asked, you replied twice from the phone, then the customer asked again
  assert.deepEqual(unansweredCustomerIds([m("c3", "inbound"), m("o2", "outbound"), m("c2", "inbound"), m("o1", "outbound"), m("c1", "inbound")]), ["c3"]);
  // several waiting messages keep their order (oldest first)
  assert.deepEqual(unansweredCustomerIds([m("c3", "inbound"), m("c2", "inbound"), m("o1", "outbound"), m("c1", "inbound")]), ["c2", "c3"]);
});

test("nothing comes back when the last message is already a reply (no double answers), or the chat is empty", () => {
  assert.deepEqual(unansweredCustomerIds([m("o1", "outbound"), m("c1", "inbound")]), []);
  assert.deepEqual(unansweredCustomerIds([]), []);
});

test("only a handful are re-queued, newest ones", () => {
  const many = Array.from({ length: 30 }, (_, i) => m(`c${30 - i}`, "inbound"));
  const out = unansweredCustomerIds(many, 10);
  assert.equal(out.length, 10);
  assert.equal(out[out.length - 1], "c30");
});
