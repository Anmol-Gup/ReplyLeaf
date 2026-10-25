import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const tile = (name: string) => readFileSync(join(process.cwd(), "public", name), "utf8");

test("doodle tiles are original outline art with the intended opacity", () => {
  for (const [name, opacity] of [["doodle-light.svg", "0.07"], ["doodle-dark.svg", "0.05"]]) {
    const svg = tile(name);
    assert.match(svg, /viewBox="0 0 240 240"/);
    assert.match(svg, new RegExp(`stroke-opacity="${opacity}"`));
    assert.match(svg, /fill="none"/);
    assert.doesNotMatch(svg, /whatsapp|meta|<image|<text/i);
    // every icon sits inside the tile with a margin, so the tile repeats without cut-off shapes
    for (const m of svg.matchAll(/translate\((\d+) (\d+)\)/g)) {
      assert.ok(Number(m[1]) >= 10 && Number(m[1]) + 32 <= 230, `x ${m[1]}`);
      assert.ok(Number(m[2]) >= 10 && Number(m[2]) + 32 <= 230, `y ${m[2]}`);
    }
  }
});
