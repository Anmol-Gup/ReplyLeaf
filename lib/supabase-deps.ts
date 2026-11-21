import { eventCategory, recipientsFor, sendNow } from "./notify-settings";
import { decryptSecret } from "./crypto";
import { getMailer } from "./email/mailer";
import { adminAlertEmail, ownerEmail, type OwnerEvent } from "./email/templates";
import { env } from "./env";
import type { InboundDeps } from "./inbound";
import { supabaseAdmin } from "./supabase-admin";
import { sendTextMessageWithRetry } from "./whatsapp/send";

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

// Business emails (new lead, appointment request, needs a human ...). Recipients come from the business's
// notification settings (primary + additional addresses, per-category switches), falling back to clients.owner_email.
// One failing address never stops the others; it only throws when NOBODY could be emailed, so the caller alerts the admin.
/**
 * WhatsApp refused or failed a message for a reason that retrying cannot fix (billing, account, permission, policy).
 * The admin alert is written by the caller; this emails the OWNER, but at most once a day per kind of problem, so an outage
 * cannot flood them. Never throws.
 */
export async function reportWhatsAppProblem(clientId: string, problem: "billing" | "account" | "permission" | "policy", detail: string): Promise<void> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const kind = `whatsapp_${problem}_notified`;
  const { count } = await db.from("admin_alerts").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("kind", kind).gte("created_at", since);
  if (count) return; // the owner was already told in the last 24 hours
  await db.from("admin_alerts").insert({ client_id: clientId, kind, detail: detail.slice(0, 300) });
  await notifyOwner(clientId, { type: "whatsapp_problem", problem });
}

export async function notifyOwner(clientId: string, event: OwnerEvent): Promise<void> {
  const db = supabaseAdmin();
  const [client, settings] = await Promise.all([
    db.from("clients").select("name, owner_email").eq("id", clientId).single(),
    db.from("notification_settings")
      .select("primary_email, additional_emails, appointment_notifications, lead_notifications, handoff_notifications, ticket_notifications, delivery")
      .eq("client_id", clientId).maybeSingle(),
  ]);
  if (client.error) throw new Error(`owner lookup failed: ${client.error.message}`);
  const s = settings.data;
  // New contacts, leads, appointment requests and tickets are batched into the daily summary unless the owner chose immediate.
  if (!sendNow({ delivery: (s?.delivery as "daily" | "immediate" | undefined) ?? "daily" }, event)) return;
  const to = recipientsFor(
    s ? { primaryEmail: s.primary_email, additionalEmails: s.additional_emails ?? [], appointments: s.appointment_notifications, leads: s.lead_notifications, handoffs: s.handoff_notifications, tickets: s.ticket_notifications } : null,
    client.data.owner_email, eventCategory(event),
  );
  const mailer = getMailer();
  if (to.length === 0 || !mailer) {
    console.warn("business email not sent (switched off, no address, or GMAIL_* not set)", event.type);
    return;
  }
  const results = await Promise.allSettled(to.map((addr) =>
    mailer.send(ownerEmail(event, { to: addr, businessName: client.data.name, appUrl: process.env.APP_URL }))));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length === results.length) throw new Error(`could not email any recipient for ${event.type}`);
  if (failed.length) console.warn(`${failed.length} of ${results.length} recipients could not be emailed`, event.type);
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
  return sendTextMessageWithRetry({ graphVersion: env().GRAPH_API_VERSION, phoneNumberId, accessToken, to, body });
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

    async recordOwnerEcho(clientId, echo) {
      const { data, error } = await db.rpc("record_owner_echo", {
        p_client_id: clientId,
        p_phone: echo.to,
        p_wa_message_id: echo.waMessageId,
        p_type: echo.type,
        p_body: echo.text,
        p_sent_at: echo.sentAt.toISOString(),
      });
      if (error) throw new Error(`record_owner_echo failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { out_duplicate: boolean };
      return { duplicate: row.out_duplicate };
    },

    async updateMessageStatus(waMessageId, status, error, extra) {
      // One SQL function: forward-only and idempotent, so a duplicate or late webhook cannot undo a delivery or double count it.
      const { error: dbErr } = await db.rpc("apply_message_status", {
        p_wa_message_id: waMessageId, p_status: status, p_error: error, p_error_code: extra?.errorCode ?? null, p_at: extra?.at?.toISOString() ?? null,
      });
      if (dbErr) throw new Error(`status update failed: ${dbErr.message}`);
    },

    async recordFreeTier(phoneNumberId, free) {
      const col = free ? "wa_free_tier_seen_at" : "wa_paid_service_seen_at";
      const { error } = await db.from("clients").update({ [col]: new Date().toISOString() }).eq("wa_phone_number_id", phoneNumberId);
      if (error) throw new Error(`free tier signal failed: ${error.message}`);
    },

    async touchWebhook(phoneNumberIds) {
      await db.from("clients").update({ last_webhook_at: new Date().toISOString() }).in("wa_phone_number_id", phoneNumberIds);
    },

    async reportDeliveryProblem(waMessageId, problem, detail) {
      if (problem === "window" || problem === "rate_limit" || problem === "delivery") return;
      const { data } = await db.from("messages").select("client_id").eq("wa_message_id", waMessageId).eq("direction", "outbound").maybeSingle();
      if (!data?.client_id) return;
      await raiseAlert(data.client_id as string, `whatsapp_${problem}`, detail);
      await reportWhatsAppProblem(data.client_id as string, problem, detail);
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
