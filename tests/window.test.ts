import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinWindow, WINDOW_MS } from "../lib/whatsapp/window";

const now = new Date("2026-01-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("open just after a customer message", () => assert.equal(isWithinWindow(ago(1000), now), true));
test("open at 23h59m", () => assert.equal(isWithinWindow(ago(WINDOW_MS - 60_000), now), true));
test("closed at exactly 24h", () => assert.equal(isWithinWindow(ago(WINDOW_MS), now), false));
test("closed after 24h", () => assert.equal(isWithinWindow(ago(WINDOW_MS + 1), now), false));
test("closed when the customer never wrote", () => assert.equal(isWithinWindow(null, now), false));
