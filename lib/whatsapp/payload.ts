import { z } from "zod";

// Only the fields we use. Everything else Meta sends is ignored, and every
// field is optional-ish so an unexpected shape never throws.
const messageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});

const statusSchema = z.object({
  id: z.string(),
  status: z.string(),
  errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() })).optional(),
});

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }),
  contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
});

// account_update: Meta's confirmation that a customer finished Embedded Signup.
// For PARTNER_ADDED the WABA id is in value.waba_info.waba_id (entry.id is then the
// customer's business portfolio); for other events entry.id is the WABA id.
const accountUpdateSchema = z.object({
  event: z.string().max(100),
  waba_info: z.object({ waba_id: z.string() }).optional(),
});

// smb_message_echoes (coexistence): a message the owner sent from the WhatsApp Business app or a linked
// device. `to` is the customer's number and is omitted when only a username/BSUID is known.
// Edits and revokes arrive in the same array (type "edit" / "revoke") and are ignored.
const echoValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }),
  message_echoes: z.array(z.object({
    id: z.string(),
    to: z.string().optional(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
  })).optional(),
});

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export type InboundMessage = {
  phoneNumberId: string; // identifies which business (client) received it
  waMessageId: string; // wamid..., our dedupe key
  from: string; // customer phone, digits only (no '+')
  sentAt: Date;
  type: string; // text | audio | image | ...
  text: string | null;
  profileName: string | null;
};

export type StatusUpdate = {
  waMessageId: string;
  status: string; // sent | delivered | read | failed
  error: string | null;
};

/** A reply the owner typed in the WhatsApp Business app. */
export type OwnerEcho = {
  phoneNumberId: string;
  waMessageId: string;
  to: string; // customer phone, digits only
  sentAt: Date;
  type: string;
  text: string | null;
};

export type AccountEvent = { wabaId: string; event: string };

export type ParsedEvents = { messages: InboundMessage[]; statuses: StatusUpdate[]; accountEvents: AccountEvent[]; echoes: OwnerEcho[] };

export function parseWebhookPayload(json: unknown): ParsedEvents {
  const out: ParsedEvents = { messages: [], statuses: [], accountEvents: [], echoes: [] };
  const payload = payloadSchema.safeParse(json);
  if (!payload.success || payload.data.object !== "whatsapp_business_account") return out;

  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
      if (change.field === "account_update") {
        const u = accountUpdateSchema.safeParse(change.value);
        const wabaId = u.success ? (u.data.waba_info?.waba_id ?? entry.id) : undefined;
        if (u.success && wabaId && /^\d{5,30}$/.test(wabaId)) out.accountEvents.push({ wabaId, event: u.data.event });
        continue;
      }
      if (change.field === "smb_message_echoes") {
        const e = echoValueSchema.safeParse(change.value);
        if (!e.success) continue;
        for (const m of e.data.message_echoes ?? []) {
          if (m.type === "edit" || m.type === "revoke" || !m.to || !/^\d{5,20}$/.test(m.to)) continue;
          out.echoes.push({
            phoneNumberId: e.data.metadata.phone_number_id, waMessageId: m.id, to: m.to,
            sentAt: new Date(Number(m.timestamp) * 1000), type: m.type, text: m.type === "text" ? (m.text?.body ?? null) : null,
          });
        }
        continue;
      }
      if (change.field !== "messages") continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) continue;
      const v = value.data;

      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        out.messages.push({
          phoneNumberId: v.metadata.phone_number_id,
          waMessageId: m.id,
          from: m.from,
          sentAt: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          text: m.type === "text" ? (m.text?.body ?? null) : null,
          profileName: name,
        });
      }
      for (const s of v.statuses ?? []) {
        out.statuses.push({
          waMessageId: s.id,
          status: s.status,
          error: s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null,
        });
      }
    }
  }
  return out;
}
