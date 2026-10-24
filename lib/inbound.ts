import type { InboundMessage, ParsedEvents } from "./whatsapp/payload";
import { isWithinWindow } from "./whatsapp/window";

// Orchestration for incoming WhatsApp events. It talks to the outside world
// only through `InboundDeps`, so unit tests can swap in in-memory fakes.

export type ClientRef = { id: string; name: string };

export type RecordResult = {
  duplicate: boolean; // true when this wamid was already stored (Meta retry)
  conversationId: string;
  handling: "bot" | "human_active";
  lastCustomerMessageAt: Date | null;
};

export type OutboundRecord = {
  clientId: string;
  conversationId: string;
  waMessageId: string | null;
  body: string;
  status: "sent" | "failed" | "blocked";
  error?: string;
};

export interface InboundDeps {
  findClientByPhoneNumberId(phoneNumberId: string): Promise<ClientRef | null>;
  /** Atomically upserts contact + conversation and inserts the message. Dedupes on wamid. */
  recordInbound(clientId: string, msg: InboundMessage): Promise<RecordResult>;
  saveOutbound(rec: OutboundRecord): Promise<void>;
  updateMessageStatus(waMessageId: string, status: string, error: string | null): Promise<void>;
  /** Looks up the token for the client, then calls the Cloud API. */
  sendText(client: ClientRef, phoneNumberId: string, to: string, body: string): Promise<{ waMessageId: string }>;
  raiseAlert(clientId: string | null, kind: string, detail: string): Promise<void>;
}

// Stage 1 uses fixed text; Stage 2 replaces this with generateReply().
export const FIXED_REPLY = "Thanks for your message! Our assistant is being set up. We'll be in touch soon.";
export const NON_TEXT_REPLY = "Sorry, I can only read text messages right now. Could you please type your message?";
export const FALLBACK_REPLY = "Sorry, something went wrong on our side. Please try again in a moment.";

export async function processEvents(events: ParsedEvents, deps: InboundDeps, now = new Date()): Promise<void> {
  for (const s of events.statuses) {
    try {
      await deps.updateMessageStatus(s.waMessageId, s.status, s.error);
    } catch (e) {
      console.error("status update failed", errorText(e));
    }
  }
  // Sequential on purpose: keeps per-customer ordering and is simple.
  for (const msg of events.messages) {
    await handleInboundMessage(msg, deps, now);
  }
}

export async function handleInboundMessage(msg: InboundMessage, deps: InboundDeps, now = new Date()): Promise<void> {
  let client: ClientRef | null = null;
  let rec: RecordResult | null = null;
  try {
    client = await deps.findClientByPhoneNumberId(msg.phoneNumberId);
    if (!client) {
      await deps.raiseAlert(null, "unknown_phone_number_id", `No client for phone_number_id ${msg.phoneNumberId}`);
      return;
    }

    rec = await deps.recordInbound(client.id, msg);
    if (rec.duplicate) return; // Meta retry: already handled
    if (rec.handling === "human_active") return; // a person owns this chat; the bot stays silent

    const body = msg.type === "text" ? FIXED_REPLY : NON_TEXT_REPLY;

    // 24h window check. Always true right after an inbound message, but the
    // same guard will protect owner replies and later automated sends.
    if (!isWithinWindow(rec.lastCustomerMessageAt, now)) {
      await deps.saveOutbound({
        clientId: client.id, conversationId: rec.conversationId, waMessageId: null,
        body, status: "blocked", error: "outside_24h_window",
      });
      return;
    }

    const sent = await deps.sendText(client, msg.phoneNumberId, msg.from, body);
    await deps.saveOutbound({
      clientId: client.id, conversationId: rec.conversationId, waMessageId: sent.waMessageId,
      body, status: "sent",
    });
  } catch (e) {
    await handleFailure(e, msg, client, rec, deps, now);
  }
}

// Any failure: alert the admin and, if it's safe, send the customer a fallback.
async function handleFailure(
  e: unknown, msg: InboundMessage, client: ClientRef | null, rec: RecordResult | null,
  deps: InboundDeps, now: Date,
): Promise<void> {
  const detail = errorText(e);
  console.error("inbound processing failed", detail);
  try {
    await deps.raiseAlert(client?.id ?? null, "inbound_processing_failed", detail);
  } catch (alertErr) {
    console.error("could not record admin alert", errorText(alertErr));
  }
  // Only message the customer if we know the chat is bot-handled and in-window.
  if (client && rec && !rec.duplicate && rec.handling === "bot" && isWithinWindow(rec.lastCustomerMessageAt, now)) {
    try {
      const sent = await deps.sendText(client, msg.phoneNumberId, msg.from, FALLBACK_REPLY);
      await deps.saveOutbound({
        clientId: client.id, conversationId: rec.conversationId, waMessageId: sent.waMessageId,
        body: FALLBACK_REPLY, status: "sent",
      });
    } catch (fallbackErr) {
      console.error("fallback send failed", errorText(fallbackErr));
    }
  }
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}
