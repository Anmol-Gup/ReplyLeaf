import { decryptSecret } from "./crypto";
import { env } from "./env";
import type { InboundDeps } from "./inbound";
import { supabaseAdmin } from "./supabase-admin";
import { sendTextMessage } from "./whatsapp/send";

// Production implementation of InboundDeps (the recording phase), plus helpers
// shared with the batch worker. Every query filters by client_id.

export async function raiseAlert(
  clientId: string | null, kind: string, detail: string, opts: { oncePerMonth?: boolean } = {},
): Promise<void> {
  const db = supabaseAdmin();
  if (opts.oncePerMonth && clientId) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { count } = await db
      .from("admin_alerts")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId).eq("kind", kind).gte("created_at", monthStart);
    if (count) return; // already alerted this month
  }
  // Stage 3 adds the admin email; for now alerts are recorded in the table.
  const { error } = await db.from("admin_alerts").insert({ client_id: clientId, kind, detail });
  if (error) throw new Error(`could not save alert: ${error.message}`);
}

// Looks up and decrypts this client's token, then calls the Cloud API.
// The caller must have checked the 24h window already.
export async function sendClientText(clientId: string, phoneNumberId: string, to: string, body: string) {
  const { data, error } = await supabaseAdmin()
    .from("client_secrets")
    .select("wa_access_token_enc")
    .eq("client_id", clientId)
    .single();
  if (error || !data?.wa_access_token_enc) throw new Error("no WhatsApp token stored for client");
  const accessToken = decryptSecret(data.wa_access_token_enc, env().ENCRYPTION_KEY);
  return sendTextMessage({ graphVersion: env().GRAPH_API_VERSION, phoneNumberId, accessToken, to, body });
}

export function supabaseInboundDeps(): InboundDeps {
  const db = supabaseAdmin();

  return {
    async findClientByPhoneNumberId(phoneNumberId) {
      const { data, error } = await db
        .from("clients")
        .select("id, name")
        .eq("wa_phone_number_id", phoneNumberId)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw new Error(`client lookup failed: ${error.message}`);
      return data;
    },

    async recordInbound(clientId, msg) {
      // One SQL function: contact + conversation upsert, message insert (unique
      // wamid dedupes) and batch queueing, all in one transaction.
      const { data, error } = await db.rpc("record_inbound_message", {
        p_client_id: clientId,
        p_phone: msg.from,
        p_profile_name: msg.profileName,
        p_wa_message_id: msg.waMessageId,
        p_type: msg.type,
        p_body: msg.text,
        p_sent_at: msg.sentAt.toISOString(),
      });
      if (error) throw new Error(`record_inbound_message failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        duplicate: row.out_duplicate,
        conversationId: row.out_conversation_id,
        handling: row.out_handling,
        lastCustomerMessageAt: row.out_last_customer_message_at ? new Date(row.out_last_customer_message_at) : null,
      };
    },

    async updateMessageStatus(waMessageId, status, error) {
      const { error: dbErr } = await db
        .from("messages")
        .update({ status, error })
        .eq("wa_message_id", waMessageId)
        .eq("direction", "outbound");
      if (dbErr) throw new Error(`status update failed: ${dbErr.message}`);
    },

    raiseAlert,
  };
}
