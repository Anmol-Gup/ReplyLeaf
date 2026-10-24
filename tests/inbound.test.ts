import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_REPLY, FIXED_REPLY, NON_TEXT_REPLY, handleInboundMessage, processEvents,
  type InboundDeps, type OutboundRecord, type RecordResult,
} from "../lib/inbound";
import type { InboundMessage } from "../lib/whatsapp/payload";
import { WINDOW_MS } from "../lib/whatsapp/window";

const NOW = new Date("2026-01-02T12:00:00Z");

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  phoneNumberId: "PNID", waMessageId: "wamid.1", from: "911", sentAt: NOW,
  type: "text", text: "hello", profileName: null, ...over,
});

// In-memory fake that mimics the SQL function: a unique wamid set = dedupe.
function fakeDeps(opts: { handling?: "bot" | "human_active"; lastAt?: Date | null; sendFails?: boolean; knownClient?: boolean } = {}) {
  const seen = new Set<string>();
  const sent: string[] = [];
  const saved: OutboundRecord[] = [];
  const alerts: string[] = [];
  const statuses: string[] = [];
  let failNextSend = opts.sendFails ?? false;
  const deps: InboundDeps = {
    findClientByPhoneNumberId: async () => (opts.knownClient === false ? null : { id: "c1", name: "Biz" }),
    recordInbound: async (_c, m): Promise<RecordResult> => {
      const duplicate = seen.has(m.waMessageId);
      seen.add(m.waMessageId);
      return {
        duplicate, conversationId: "conv1", handling: opts.handling ?? "bot",
        lastCustomerMessageAt: opts.lastAt === undefined ? m.sentAt : opts.lastAt,
      };
    },
    saveOutbound: async (r) => void saved.push(r),
    updateMessageStatus: async (id, s) => void statuses.push(`${id}:${s}`),
    sendText: async (_c, _p, _to, body) => {
      if (failNextSend) { failNextSend = false; throw new Error("graph down"); }
      sent.push(body);
      return { waMessageId: `out.${sent.length}` };
    },
    raiseAlert: async (_c, kind) => void alerts.push(kind),
  };
  return { deps, sent, saved, alerts, statuses };
}

test("replies once with the fixed text and stores the outbound message", async () => {
  const f = fakeDeps();
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.deepEqual(f.sent, [FIXED_REPLY]);
  assert.equal(f.saved[0].status, "sent");
});

test("dedupe: a Meta retry of the same wamid does not reply twice", async () => {
  const f = fakeDeps();
  await handleInboundMessage(msg(), f.deps, NOW);
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.equal(f.sent.length, 1);
  // a different wamid is a new message and does get a reply
  await handleInboundMessage(msg({ waMessageId: "wamid.2" }), f.deps, NOW);
  assert.equal(f.sent.length, 2);
});

test("human takeover: the bot stays silent", async () => {
  const f = fakeDeps({ handling: "human_active" });
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.equal(f.sent.length, 0);
  assert.equal(f.saved.length, 0);
});

test("24h window: a send outside the window is blocked and recorded, not sent", async () => {
  const f = fakeDeps({ lastAt: new Date(NOW.getTime() - WINDOW_MS - 1) });
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.equal(f.sent.length, 0);
  assert.equal(f.saved[0].status, "blocked");
  assert.equal(f.saved[0].error, "outside_24h_window");
});

test("non-text messages get the ask-for-text reply", async () => {
  const f = fakeDeps();
  await handleInboundMessage(msg({ type: "audio", text: null }), f.deps, NOW);
  assert.deepEqual(f.sent, [NON_TEXT_REPLY]);
});

test("failure: alerts the admin and sends the customer a safe fallback", async () => {
  const f = fakeDeps({ sendFails: true });
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.deepEqual(f.alerts, ["inbound_processing_failed"]);
  assert.deepEqual(f.sent, [FALLBACK_REPLY]);
});

test("unknown phone_number_id raises an alert and sends nothing", async () => {
  const f = fakeDeps({ knownClient: false });
  await handleInboundMessage(msg(), f.deps, NOW);
  assert.deepEqual(f.alerts, ["unknown_phone_number_id"]);
  assert.equal(f.sent.length, 0);
});

test("processEvents handles statuses and several messages in order", async () => {
  const f = fakeDeps();
  await processEvents(
    { statuses: [{ waMessageId: "out.1", status: "delivered", error: null }],
      messages: [msg(), msg({ waMessageId: "wamid.2" })] },
    f.deps, NOW,
  );
  assert.deepEqual(f.statuses, ["out.1:delivered"]);
  assert.equal(f.sent.length, 2);
});
