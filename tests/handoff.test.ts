import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedActions, cleanAssignee, cleanNote, conversationState, handoffFormSchema, HANDOFF_ACTIONS, HANDOFF_STATUSES,
  isOpen, nextStatus, summaryOrFallback,
} from "../lib/handoff";

test("allowed moves follow the lifecycle: requested -> assigned -> human_active -> resolved", () => {
  assert.equal(nextStatus("requested", "assign"), "assigned");
  assert.equal(nextStatus("requested", "take_over"), "human_active");
  assert.equal(nextStatus("assigned", "take_over"), "human_active");
  assert.equal(nextStatus("human_active", "assign"), "human_active"); // reassigning keeps the status
  assert.equal(nextStatus("human_active", "resolve"), "resolved");
  assert.equal(nextStatus("assigned", "resume_ai"), "resolved");
});

test("moves that are not allowed return null (and the buttons are not shown)", () => {
  assert.equal(nextStatus("human_active", "take_over"), null);
  for (const a of HANDOFF_ACTIONS) assert.equal(nextStatus("resolved", a), null);
  assert.deepEqual(allowedActions("resolved"), []);
  assert.ok(allowedActions("requested").includes("take_over"));
  assert.ok(!allowedActions("human_active").includes("take_over"));
});

test("every status is either open or resolved, and a resolved handoff has no actions", () => {
  assert.deepEqual(HANDOFF_STATUSES.filter(isOpen), ["requested", "assigned", "human_active"]);
});

test("conversation states combine the assistant switch with the handoff record", () => {
  assert.equal(conversationState("bot", null), "ai_active");
  assert.equal(conversationState("human_active", "requested"), "handoff_requested");
  assert.equal(conversationState("human_active", "assigned"), "assigned");
  assert.equal(conversationState("human_active", "human_active"), "human_active");
  assert.equal(conversationState("human_active", "resolved"), "resolved"); // resolved but the assistant is still paused
  assert.equal(conversationState("bot", "resolved"), "ai_active");
});

test("assignee: trimmed, control characters removed, length limited", () => {
  assert.equal(cleanAssignee("  Priya  Sharma "), "Priya Sharma");
  assert.equal(cleanAssignee("a@b.com\n<script>"), "a@b.com <script>"); // stored as plain text and escaped when shown
  assert.equal(cleanAssignee(""), null);
  assert.equal(cleanAssignee("x".repeat(101)), null);
  assert.equal(cleanAssignee(42), null);
});

test("notes: empty clears, too long is rejected", () => {
  assert.equal(cleanNote("  call back at 5 "), "call back at 5");
  assert.equal(cleanNote("   "), "");
  assert.equal(cleanNote("x".repeat(2001)), null);
});

test("form input is validated: a real id and a known action", () => {
  assert.ok(handoffFormSchema.safeParse({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", action: "resolve" }).success);
  assert.ok(!handoffFormSchema.safeParse({ id: "not-a-uuid", action: "resolve" }).success);
  assert.ok(!handoffFormSchema.safeParse({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", action: "delete_everything" }).success);
});

test("summary: the model's text is trimmed and capped; otherwise built from the last message", () => {
  assert.equal(summaryOrFallback("  Wants   a refund. ", "x"), "Wants a refund.");
  assert.equal(summaryOrFallback("y".repeat(900), "x").length, 400);
  assert.equal(summaryOrFallback(null, "Where is my order?"), "Last message: Where is my order?");
  assert.equal(summaryOrFallback("  ", ""), "No summary available.");
});
