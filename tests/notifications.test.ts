import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOASTS, pickToasts, safeLink, type LiveNotification } from "../lib/notifications";

const n = (id: string, at: string, read = false): LiveNotification => ({ id, kind: "handoff", title: "t", body: null, link: null, read, created_at: at });

test("toasts: unread, new, newest few; never repeated", () => {
  const list = [n("a", "2026-01-01"), n("b", "2026-01-02"), n("c", "2026-01-03", true), n("d", "2026-01-04"), n("e", "2026-01-05")];
  const first = pickToasts(list, new Set(), null, false).map((x) => x.id);
  assert.equal(first.length, MAX_TOASTS);
  assert.deepEqual(first, ["b", "d", "e"]);
  assert.deepEqual(pickToasts(list, new Set(["b", "d", "e"]), null, false).map((x) => x.id), ["a"]);
});
test("first poll after a reload only toasts what is newer than last seen", () => {
  const list = [n("a", "2026-01-01"), n("b", "2026-01-03")];
  assert.deepEqual(pickToasts(list, new Set(), "2026-01-02", true).map((x) => x.id), ["b"]);
  assert.deepEqual(pickToasts(list, new Set(), null, true).map((x) => x.id), ["a", "b"]);
});
test("links stay inside the dashboard", () => {
  assert.equal(safeLink("/dashboard/conversations/x"), "/dashboard/conversations/x");
  assert.equal(safeLink("https://evil.com"), "/dashboard");
  assert.equal(safeLink("//evil.com"), "/dashboard");
  assert.equal(safeLink(null), "/dashboard");
});
