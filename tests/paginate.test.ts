import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, paginate } from "../lib/paginate";

const items = Array.from({ length: 23 }, (_, i) => i + 1);

test("paginate slices pages and reports the range", () => {
  const p1 = paginate(items, "1", 10);
  assert.deepEqual([p1.items.length, p1.page, p1.pages, p1.total, p1.from, p1.to], [10, 1, 3, 23, 1, 10]);
  const p3 = paginate(items, "3", 10);
  assert.deepEqual([p3.items, p3.from, p3.to], [[21, 22, 23], 21, 23]);
});

test("paginate clamps bad page numbers from the URL instead of failing", () => {
  assert.equal(paginate(items, "0", 10).page, 1);
  assert.equal(paginate(items, "-4", 10).page, 1);
  assert.equal(paginate(items, "abc", 10).page, 1);
  assert.equal(paginate(items, undefined, 10).page, 1);
  assert.equal(paginate(items, "999", 10).page, 3); // beyond the end shows the last page
  assert.equal(paginate(items, "2.7", 10).page, 2);
});

test("an empty list is one empty page with a 0-0 range", () => {
  const p = paginate([], "1", 10);
  assert.deepEqual([p.items.length, p.page, p.pages, p.total, p.from, p.to], [0, 1, 1, 0, 0, 0]);
});

test("an exact multiple of the page size does not create an empty last page", () => {
  assert.equal(paginate(Array.from({ length: 20 }, (_, i) => i), "2", 10).pages, 2);
});

test("buildQuery keeps set values, drops empty ones, and encodes", () => {
  assert.equal(buildQuery({ q: "asha k", page: 2, status: "" }), "?q=asha+k&page=2");
  assert.equal(buildQuery({ q: undefined, page: null }), "");
  assert.equal(buildQuery({ wp: 3, ap: null }), "?wp=3");
});
