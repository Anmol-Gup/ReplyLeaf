import { decryptSecret } from "./crypto";
import { getMailer } from "./email/mailer";
import { adminAlertEmail, ownerEmail, type OwnerEvent } from "./email/templates";
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
  const { data, error } = await db.from("admin_alerts").insert({ client_id: clientId, kind, detail }).select("id").single();
  if (error) throw new Error(`could not save alert: ${error.message}`);
  await emailAdmin(data.id, clientId, kind, detail);
}

// Email the admin about an alert. Never throws: alerting must not cause more failures.
async function emailAdmin(alertId: string, clientId: string | null, kind: string, detail: string): Promise<void> {
  try {
    const to = process.env.ADMIN_ALERT_EMAIL;
    const mailer = getMailer();
    if (!to || !mailer) {
      console.warn("admin alert not emailed (set ADMIN_ALERT_EMAIL and GMAIL_* to enable)", kind);
      return;
    }
    const db = supabaseAdmin();
    // Storm guard: during an outage every message fails the same way. Email the
    // first alert of a kind per client in a 10-minute window; the rest stay in the table.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let q = db.from("admin_alerts").select("id", { count: "exact", head: true }).eq("kind", kind).gte("created_at", since);
    q = clientId ? q.eq("client_id", clientId) : q.is("client_id", null);
    const { count } = await q;
    if ((count ?? 0) > 1) return;

    let clientName: string | null = null;
    if (clientId) {
      const { data } = await db.from("clients").select("name").eq("id", clientId).maybeSingle();
      clientName = data?.name ?? null;
    }
    await mailer.send(adminAlertEmail({ to, kind, detail, clientName }));
    await db.from("admin_alerts").update({ emailed_at: new Date().toISOString() }).eq("id", alertId);
  } catch (e) {
    console.error("admin alert email failed", e instanceof Error ? e.message : e);
  }
}

// Owner alerts (new lead, new booking request, needs a human) go to clients.owner_email.
export async function notifyOwner(clientId: string, event: OwnerEvent): Promise<void> {
  const { data, error } = await supabaseAdmin()
    .from("clients").select("name, owner_email").eq("id", clientId).single();
  if (error) throw new Error(`owner lookup failed: ${error.message}`);
  const mailer = getMailer();
  if (!data.owner_email || !mailer) {
    console.warn("owner alert not emailed (no owner_email or GMAIL_* not set)", event.type);
    return;
  }
  await mailer.send(ownerEmail(event, { to: data.owner_email, businessName: data.name, appUrl: process.env.APP_URL }));
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

    async applyAccountEvent(wabaId, event) {
      const { data, error } = await db.rpc("apply_account_event", { p_waba_id: wabaId, p_event: event });
      if (error) throw new Error(`apply_account_event failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { out_client_id: string | null } | null;
      // The customer removed our app from their WhatsApp account: the admin should know.
      if (event === "PARTNER_REMOVED") await raiseAlert(row?.out_client_id ?? null, "partner_removed", `WABA ${wabaId}`);
    },

    raiseAlert,
  };
}
