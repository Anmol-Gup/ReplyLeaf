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

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
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

export type ParsedEvents = { messages: InboundMessage[]; statuses: StatusUpdate[] };

export function parseWebhookPayload(json: unknown): ParsedEvents {
  const out: ParsedEvents = { messages: [], statuses: [] };
  const payload = payloadSchema.safeParse(json);
  if (!payload.success || payload.data.object !== "whatsapp_business_account") return out;

  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
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
