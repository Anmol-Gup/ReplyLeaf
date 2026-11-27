import assert from "node:assert/strict";
import test from "node:test";
import { compareConversations, conversationActions, conversationStateOf, isUnread, matchesFilter } from "../lib/conversation-state";

test("state per viewer", () => {
  assert.equal(conversationStateOf("bot", null, "u1"), "ai");
  assert.equal(conversationStateOf("human_active", { status: "requested", assigned_user_id: null }, "u1"), "waiting");
  assert.equal(conversationStateOf("human_active", { status: "human_active", assigned_user_id: "u1" }, "u1"), "mine");
  assert.equal(conversationStateOf("human_active", { status: "human_active", assigned_user_id: "u2" }, "u1"), "other");
});
test("only the assignee may reply; the other agent has no button", () => {
  assert.deepEqual(conversationActions("ai"), { button: "take_over", canReply: false });
  assert.deepEqual(conversationActions("waiting"), { button: "take_over", canReply: false });
  // paused because the owner replied from the WhatsApp Business app: the badge stays "Waiting for human", the button is Resume AI
  assert.deepEqual(conversationActions("waiting", { status: "human_active", assigned_user_id: null, source: "owner" }), { button: "resume_ai", canReply: false });
  assert.deepEqual(conversationActions("waiting", { status: "requested", assigned_user_id: null, source: "customer_request" }), { button: "take_over", canReply: false });
  assert.deepEqual(conversationActions("mine"), { button: "resume_ai", canReply: true });
  assert.deepEqual(conversationActions("other"), { button: null, canReply: false });
});
test("filters, sorting and unread", () => {
  assert.ok(matchesFilter("assigned", "other", false) && matchesFilter("assigned", "mine", false) && !matchesFilter("assigned", "waiting", false));
  assert.ok(matchesFilter("unread", "ai", true) && !matchesFilter("unread", "ai", false));
  const rows = [{ state: "ai" as const, lastAt: "2026-01-03" }, { state: "waiting" as const, lastAt: "2026-01-01" }, { state: "mine" as const, lastAt: "2026-01-02" }];
  assert.deepEqual(rows.sort(compareConversations).map((r) => r.state), ["waiting", "ai", "mine"]);
  assert.equal(isUnread(null, null), false);
  assert.equal(isUnread("2026-01-02", null), true);
  assert.equal(isUnread("2026-01-02", "2026-01-03"), false);
  assert.equal(isUnread("2026-01-04", "2026-01-03"), true);
});
