import { decryptSecret } from "./crypto";
import { env } from "./env";
import type { InboundDeps } from "./inbound";
import { supabaseAdmin } from "./supabase-admin";
import { sendTextMessage } from "./whatsapp/send";

// Production implementation of InboundDeps, backed by Supabase + the Cloud API.
export function supabaseDeps(): InboundDeps {
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
      // One SQL function does contact + conversation upsert and the message
      // insert in a single transaction; the unique wa_message_id dedupes.
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

    async saveOutbound(rec) {
      const { error } = await db.from("messages").insert({
        client_id: rec.clientId,
        conversation_id: rec.conversationId,
        direction: "outbound",
        sender: "bot",
        type: "text",
        body: rec.body,
        wa_message_id: rec.waMessageId,
        status: rec.status,
        error: rec.error ?? null,
      });
      if (error) throw new Error(`saving outbound message failed: ${error.message}`);
    },

    async updateMessageStatus(waMessageId, status, error) {
      const { error: dbErr } = await db
        .from("messages")
        .update({ status, error })
        .eq("wa_message_id", waMessageId)
        .eq("direction", "outbound");
      if (dbErr) throw new Error(`status update failed: ${dbErr.message}`);
    },

    async sendText(client, phoneNumberId, to, body) {
      const { data, error } = await db
        .from("client_secrets")
        .select("wa_access_token_enc")
        .eq("client_id", client.id)
        .single();
      if (error || !data?.wa_access_token_enc) throw new Error("no WhatsApp token stored for client");
      const accessToken = decryptSecret(data.wa_access_token_enc, env().ENCRYPTION_KEY);
      return sendTextMessage({ graphVersion: env().GRAPH_API_VERSION, phoneNumberId, accessToken, to, body });
    },

    async raiseAlert(clientId, kind, detail) {
      // Stage 3 adds the admin email; for now alerts are recorded + logged.
      const { error } = await db.from("admin_alerts").insert({ client_id: clientId, kind, detail });
      if (error) throw new Error(`could not save alert: ${error.message}`);
    },
  };
}
