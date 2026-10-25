import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const tile = (name: string) => readFileSync(join(process.cwd(), "public", name), "utf8");

test("doodle tiles are original outline art with the intended opacity", () => {
  for (const [name, opacity] of [["doodle-light.svg", "0.07"]]) {
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

test("the app is light theme only", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
  assert.match(css, /color-scheme:\s*light/);
});

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test("secondary grey text meets WCAG AA on the beige backdrop, white cards and green bubbles", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(muted);
  for (const bg of ["#efeae2", "#ffffff", "#f6f2ea", "#d8f0dc"]) {
    assert.ok(ratio(muted, bg) >= 4.5, `${muted} on ${bg} = ${ratio(muted, bg).toFixed(2)}`);
  }
});
