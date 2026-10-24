import type { AccountEvent, InboundMessage, ParsedEvents } from "./whatsapp/payload";

// Recording phase of the webhook: fast, DB-only, runs BEFORE we answer Meta.
// It stores each message (deduped) and says which conversations need a batch.
// Replying happens later in batch.ts. Everything goes through `InboundDeps`
// so unit tests can use in-memory fakes.

export type ClientRef = { id: string; name: string };

export type RecordResult = {
  duplicate: boolean; // true when this wamid was already stored (Meta retry)
  conversationId: string;
  handling: "bot" | "human_active";
  lastCustomerMessageAt: Date | null;
};

export interface InboundDeps {
  findClientByPhoneNumberId(phoneNumberId: string): Promise<ClientRef | null>;
  /** Atomically upserts contact + conversation, inserts the message and queues it for batching. Dedupes on wamid. */
  recordInbound(clientId: string, msg: InboundMessage): Promise<RecordResult>;
  updateMessageStatus(waMessageId: string, status: string, error: string | null): Promise<void>;
  /** account_update from Meta: records it and updates the matching client's onboarding status. */
  applyAccountEvent(wabaId: string, event: string): Promise<void>;
  raiseAlert(clientId: string | null, kind: string, detail: string): Promise<void>;
}

export type RecordOutcome = {
  /** Bot-handled conversations to schedule a batch for (deduped). */
  conversationIds: string[];
  /** Messages we failed to store. The route answers 500 so Meta retries them. */
  failed: number;
};

export async function recordEvents(
  events: Omit<ParsedEvents, "accountEvents"> & { accountEvents?: AccountEvent[] },
  deps: InboundDeps,
): Promise<RecordOutcome> {
  for (const s of events.statuses) {
    try {
      await deps.updateMessageStatus(s.waMessageId, s.status, s.error);
    } catch (e) {
      console.error("status update failed", errorText(e));
    }
  }

  const conversationIds = new Set<string>();
  let failed = 0;

  // Onboarding confirmations. A failure counts as failed so Meta retries the webhook.
  for (const a of events.accountEvents ?? []) {
    try {
      await deps.applyAccountEvent(a.wabaId, a.event);
    } catch (e) {
      failed++;
      console.error("account_update failed", errorText(e));
    }
  }

  // Sequential on purpose: keeps per-customer ordering and is simple.
  for (const msg of events.messages) {
    try {
      const client = await deps.findClientByPhoneNumberId(msg.phoneNumberId);
      if (!client) {
        // Retrying won't help, so don't count as failed.
        await deps.raiseAlert(null, "unknown_phone_number_id", `No client for phone_number_id ${msg.phoneNumberId}`);
        continue;
      }
      const rec = await deps.recordInbound(client.id, msg);
      // A human owns this chat: stored, but the bot stays silent.
      // Duplicates are scheduled too: if the first attempt stored the message
      // but died before replying, the claim step picks the batch back up, and if
      // it was already handled the claim simply fails.
      if (rec.handling === "bot") conversationIds.add(rec.conversationId);
    } catch (e) {
      failed++;
      console.error("recording inbound message failed", errorText(e));
      try {
        await deps.raiseAlert(null, "inbound_record_failed", errorText(e));
      } catch {
        /* alerting must never break the webhook */
      }
    }
  }
  return { conversationIds: [...conversationIds], failed };
}

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}
