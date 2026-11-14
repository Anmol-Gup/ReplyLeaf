import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebhookPayload } from "../lib/whatsapp/payload";

const wrap = (value: unknown, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field, value }] }],
});
const meta = { phone_number_id: "PNID", display_phone_number: "15550000000" };

test("extracts a text message with profile name", () => {
  const { messages } = parseWebhookPayload(wrap({
    metadata: meta,
    contacts: [{ wa_id: "911", profile: { name: "Asha" } }],
    messages: [{ id: "wamid.1", from: "911", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
  }));
  assert.equal(messages.length, 1);
  assert.deepEqual(
    { id: messages[0].waMessageId, pn: messages[0].phoneNumberId, text: messages[0].text, name: messages[0].profileName },
    { id: "wamid.1", pn: "PNID", text: "hi", name: "Asha" },
  );
  assert.equal(messages[0].sentAt.getTime(), 1700000000_000);
});
test("non-text messages have text = null", () => {
  const { messages } = parseWebhookPayload(wrap({
    metadata: meta,
    messages: [{ id: "wamid.2", from: "911", timestamp: "1700000000", type: "audio", audio: { id: "x" } }],
  }));
  assert.equal(messages[0].type, "audio");
  assert.equal(messages[0].text, null);
});
test("extracts statuses", () => {
  const { statuses, messages } = parseWebhookPayload(wrap({
    metadata: meta, statuses: [{ id: "wamid.3", status: "failed", errors: [{ message: "boom" }] }],
  }));
  assert.equal(messages.length, 0);
  assert.deepEqual(statuses, [{ waMessageId: "wamid.3", status: "failed", error: "boom" }]);
});
test("garbage and other fields yield no events and never throw", () => {
  for (const bad of [null, "x", {}, { object: "page", entry: [] }, wrap({ nope: 1 }), wrap({ metadata: meta }, "account_update")]) {
    const r = parseWebhookPayload(bad);
    assert.equal(r.messages.length + r.statuses.length, 0);
  }
});

test("smb_message_echoes: owner replies become echoes; edits, revokes and user-less echoes are ignored", () => {
  const env = (echoes: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "PNID" }, message_echoes: echoes } }] }],
  });
  const r = parseWebhookPayload(env([
    { from: "1", to: "919800000001", id: "wamid.a", timestamp: "1700000000", type: "text", text: { body: "hi" } },
    { from: "1", to: "919800000001", id: "wamid.b", timestamp: "1700000001", type: "image" },
    { from: "1", to: "919800000001", id: "wamid.c", timestamp: "1700000002", type: "revoke", revoke: { original_message_id: "wamid.a" } },
    { from: "1", to: "919800000001", id: "wamid.d", timestamp: "1700000003", type: "edit", edit: { original_message_id: "wamid.a" } },
    { from: "1", id: "wamid.e", timestamp: "1700000004", type: "text", text: { body: "no recipient" } },
  ]));
  assert.deepEqual(r.echoes.map((e) => [e.waMessageId, e.to, e.phoneNumberId, e.text]), [["wamid.a", "919800000001", "PNID", "hi"], ["wamid.b", "919800000001", "PNID", null]]);
  assert.equal(r.messages.length, 0);
});
