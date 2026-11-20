import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveSelection, parseMulti, selectionSummary } from "../lib/filters";
import { buildQuery } from "../lib/paginate";

const ALLOWED = ["new", "qualified", "won", "lost"] as const;

test("parseMulti: repeated or comma-separated values, only known ones, in the listed order, no duplicates", () => {
  assert.deepEqual(parseMulti(["won", "new"], ALLOWED), ["new", "won"]);
  assert.deepEqual(parseMulti("won,new,won", ALLOWED), ["new", "won"]);
  assert.deepEqual(parseMulti(["nope", "../x", ""], ALLOWED), []);
  assert.deepEqual(parseMulti(undefined, ALLOWED), []);
});

test("effectiveSelection: nothing chosen means the default; a real choice wins and is marked explicit", () => {
  assert.deepEqual(effectiveSelection(undefined, ALLOWED, ["new", "qualified"]), { selected: ["new", "qualified"], explicit: false });
  assert.deepEqual(effectiveSelection(["garbage"], ALLOWED, ["new"]), { selected: ["new"], explicit: false });
  assert.deepEqual(effectiveSelection(["lost"], ALLOWED, ["new"]), { selected: ["lost"], explicit: true });
});

test("selectionSummary: All, a short list, or a list with a count", () => {
  const opts = ALLOWED.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
  assert.equal(selectionSummary([], opts), "All");
  assert.equal(selectionSummary([...ALLOWED], opts), "All");
  assert.equal(selectionSummary(["won"], opts), "Won");
  assert.equal(selectionSummary(["new", "won"], opts), "New, Won");
  assert.equal(selectionSummary(["new", "qualified", "lost"], opts), "New, Qualified +1");
});

test("buildQuery: arrays become repeated parameters and empty ones disappear", () => {
  assert.equal(buildQuery({ status: ["new", "won"], q: "candle", page: 2 }), "?status=new&status=won&q=candle&page=2");
  assert.equal(buildQuery({ status: [], q: "" }), "");
  assert.equal(buildQuery({ q: "a b" }), "?q=a+b");
});

import { filterHref } from "../lib/filters";
test("filterHref: the chosen statuses, the search text and other switches go into the address; nothing chosen means no status", () => {
  assert.equal(filterHref("/dashboard/appointments", ["pending", "confirmed"], { q: "ravi", upcoming: "1" }), "/dashboard/appointments?status=pending&status=confirmed&q=ravi&upcoming=1");
  assert.equal(filterHref("/dashboard/appointments", [], { q: undefined }), "/dashboard/appointments");
  assert.equal(filterHref("/dashboard/leads", ["won"]), "/dashboard/leads?status=won");
});
