import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BULK, parseIds } from "../lib/bulk";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
test("bulk ids: only valid ones, no repeats, capped", () => {
  assert.deepEqual(parseIds([id(1), id(1), "x", 5, null, "' or 1=1 --", id(2)]), [id(1), id(2)]);
  assert.equal(parseIds(Array.from({ length: 500 }, (_, i) => id(i))).length, MAX_BULK);
  assert.deepEqual(parseIds([]), []);
});
