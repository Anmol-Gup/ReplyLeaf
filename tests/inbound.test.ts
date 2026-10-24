import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEvents, type InboundDeps, type RecordResult } from "../lib/inbound";
import type { InboundMessage } from "../lib/whatsapp/payload";

const NOW = new Date("2026-01-02T12:00:00Z");
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  phoneNumberId: "PNID", waMessageId: "wamid.1", from: "911", sentAt: NOW,
  type: "text", text: "hello", profileName: null, ...over,
});

// In-memory fake mimicking the SQL function: a unique wamid set = dedupe.
function fakeDeps(opts: { handling?: "bot" | "human_active"; knownClient?: boolean; dbFails?: boolean } = {}) {
  const stored: string[] = [];
  const alerts: string[] = [];
  const statuses: string[] = [];
  const deps: InboundDeps = {
    findClientByPhoneNumberId: async () => (opts.knownClient === false ? null : { id: "c1", name: "Biz" }),
    recordInbound: async (_c, m): Promise<RecordResult> => {
      if (opts.dbFails) throw new Error("db down");
      const duplicate = stored.includes(m.waMessageId);
      if (!duplicate) stored.push(m.waMessageId);
      return { duplicate, conversationId: "conv1", handling: opts.handling ?? "bot", lastCustomerMessageAt: m.sentAt };
    },
    updateMessageStatus: async (id, s) => void statuses.push(`${id}:${s}`),
    raiseAlert: async (_c, kind) => void alerts.push(kind),
  };
  return { deps, stored, alerts, statuses };
}

test("stores each message once and schedules its conversation once", async () => {
  const f = fakeDeps();
  const out = await recordEvents({ statuses: [], messages: [msg(), msg({ waMessageId: "wamid.2" })] }, f.deps);
  assert.deepEqual(f.stored, ["wamid.1", "wamid.2"]);
  assert.deepEqual(out.conversationIds, ["conv1"]); // two messages, one batch
  assert.equal(out.failed, 0);
});

test("dedupe: a Meta retry of the same wamid is stored only once", async () => {
  const f = fakeDeps();
  await recordEvents({ statuses: [], messages: [msg()] }, f.deps);
  const again = await recordEvents({ statuses: [], messages: [msg()] }, f.deps);
  assert.deepEqual(f.stored, ["wamid.1"]);
  // the retry still schedules the conversation, so a batch stranded by a crash is picked up
  assert.deepEqual(again.conversationIds, ["conv1"]);
});

test("human takeover: message is stored but no batch is scheduled", async () => {
  const f = fakeDeps({ handling: "human_active" });
  const out = await recordEvents({ statuses: [], messages: [msg()] }, f.deps);
  assert.deepEqual(f.stored, ["wamid.1"]);
  assert.deepEqual(out.conversationIds, []);
});

test("storage failure: alerts and reports failed so the route can return 500 (Meta retries)", async () => {
  const f = fakeDeps({ dbFails: true });
  const out = await recordEvents({ statuses: [], messages: [msg()] }, f.deps);
  assert.equal(out.failed, 1);
  assert.deepEqual(f.alerts, ["inbound_record_failed"]);
});

test("unknown phone_number_id alerts but is not a retryable failure", async () => {
  const f = fakeDeps({ knownClient: false });
  const out = await recordEvents({ statuses: [], messages: [msg()] }, f.deps);
  assert.equal(out.failed, 0);
  assert.deepEqual(f.alerts, ["unknown_phone_number_id"]);
});

test("delivery statuses are recorded", async () => {
  const f = fakeDeps();
  await recordEvents({ statuses: [{ waMessageId: "out.1", status: "delivered", error: null }], messages: [] }, f.deps);
  assert.deepEqual(f.statuses, ["out.1:delivered"]);
});
