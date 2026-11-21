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

import { badgeText, decodeCursor, encodeCursor, groupByDay, matchesDrawerFilter, mergeItems } from "../lib/notifications";

test("badge text: exact, then 9+, then 99+", () => {
  assert.deepEqual([0, 1, 9, 10, 99, 100].map(badgeText), ["0", "1", "9", "9+", "9+", "99+"]);
});
test("cursor round-trips and rejects junk", () => {
  const c = encodeCursor("2026-11-21T07:45:00.123456+00:00", "11111111-1111-1111-1111-111111111111");
  assert.deepEqual(decodeCursor(c), { at: "2026-11-21T07:45:00.123456+00:00", id: "11111111-1111-1111-1111-111111111111" });
  assert.equal(decodeCursor('x"),id.gt.0|11111111-1111-1111-1111-111111111111'), null); // nothing can be injected into the filter
  assert.equal(decodeCursor(null), null);
});
test("merge: no duplicates, newest first, newer copy wins", () => {
  const a = n("a", "2026-01-01T10:00:00Z"), b = n("b", "2026-01-02T10:00:00Z");
  const merged = mergeItems([a, b], [{ ...a, read: true }, n("c", "2026-01-03T10:00:00Z")]);
  assert.deepEqual(merged.map((x) => x.id), ["c", "b", "a"]);
  assert.equal(merged[2].read, true);
});
test("drawer filters: message counts with handoff; unread follows read state", () => {
  const msg = { ...n("m", "2026-01-01T10:00:00Z"), kind: "message" };
  assert.ok(matchesDrawerFilter("handoff", msg) && !matchesDrawerFilter("ticket", msg) && matchesDrawerFilter("all", msg));
  assert.ok(matchesDrawerFilter("unread", msg) && !matchesDrawerFilter("unread", { ...msg, read: true }));
});
test("groups by the viewer's local day", () => {
  const now = new Date(2026, 10, 21, 12, 0, 0);
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).toISOString();
  const g = groupByDay([n("1", at(21, 9)), n("2", at(20, 23)), n("3", at(20, 1)), n("4", at(10, 5))], now);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [["Today", 1], ["Yesterday", 2], ["Earlier", 1]]);
});
