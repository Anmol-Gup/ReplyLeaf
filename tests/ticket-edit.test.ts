import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIORITIES, PRIORITY_LABELS, ticketFormSchema } from "../lib/tickets";
import { effectiveSelection } from "../lib/filters";
import { filterHref } from "../lib/filters";

const ID = "11111111-1111-4111-8111-111111111111";
const base = { id: ID, status: "open", assigned_to: "", notes: "", message: "" };

test("ticket priority: Normal or Urgent, editable, and left unchanged when the form does not send it", () => {
  assert.deepEqual([...PRIORITIES], ["normal", "high"]);
  assert.deepEqual([PRIORITY_LABELS.normal, PRIORITY_LABELS.high], ["Normal", "Urgent"]);
  assert.equal(ticketFormSchema.parse({ ...base, priority: "high" }).priority, "high");
  assert.equal(ticketFormSchema.parse({ ...base, priority: "normal" }).priority, "normal");
  assert.equal(ticketFormSchema.parse(base).priority, undefined);                         // older forms keep working: priority unchanged
  assert.equal(ticketFormSchema.safeParse({ ...base, priority: "critical" }).success, false);
  assert.equal(ticketFormSchema.safeParse({ ...base, priority: "" }).success, false);
});

test("the priority filter: nothing chosen means every priority; a choice is validated", () => {
  assert.deepEqual(effectiveSelection(undefined, PRIORITIES, []), { selected: [], explicit: false });
  assert.deepEqual(effectiveSelection(["high"], PRIORITIES, []), { selected: ["high"], explicit: true });
  assert.deepEqual(effectiveSelection(["high", "normal", "x"], PRIORITIES, []), { selected: ["normal", "high"], explicit: true });
  assert.deepEqual(effectiveSelection(["bogus"], PRIORITIES, []), { selected: [], explicit: false });
});

test("the status and priority filters keep each other's choice, and the search, in the address", () => {
  // changing the status keeps the priority
  assert.equal(filterHref("/dashboard/tickets", ["open", "in_progress"], { q: "order", priority: ["high"] }), "/dashboard/tickets?status=open&status=in_progress&q=order&priority=high");
  // changing the priority keeps the status
  assert.equal(filterHref("/dashboard/tickets", ["high"], { status: ["open"] }, "priority"), "/dashboard/tickets?priority=high&status=open");
  // resetting one leaves the other
  assert.equal(filterHref("/dashboard/tickets", [], { status: ["open"] }, "priority"), "/dashboard/tickets?status=open");
  assert.equal(filterHref("/dashboard/tickets", [], { priority: [] }), "/dashboard/tickets");
});
