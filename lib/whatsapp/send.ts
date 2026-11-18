import { z } from "zod";

const responseSchema = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) });

export class WhatsAppApiError extends Error {
  /** `code` is Meta's own error code (for example 131042 = payment problem), when the response had one. */
  constructor(message: string, readonly status: number, readonly code: number | null = null) {
    super(message);
  }
}

// Send a free-form text message. The caller MUST have checked the 24-hour
// window first (see window.ts); this function does not.
// Never log or include `accessToken` in errors.
export async function sendTextMessage(opts: {
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  to: string; // digits only, as received in the webhook
  body: string;
}): Promise<{ waMessageId: string }> {
  const res = await fetch(
    `https://graph.facebook.com/${opts.graphVersion}/${opts.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${opts.to}`, // docs: include the plus sign and country code
        type: "text",
        text: { body: opts.body },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number } } | null)?.error;
    const msg = err?.message ?? "unknown error";
    throw new WhatsAppApiError(`WhatsApp send failed (${res.status}): ${msg}`, res.status, typeof err?.code === "number" ? err.code : null);
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new WhatsAppApiError("Unexpected WhatsApp send response", res.status);
  return { waMessageId: parsed.data.messages[0].id };
}
