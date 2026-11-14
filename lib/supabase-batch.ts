import { aiConfig } from "./ai/config";
import { generateReply } from "./ai/generate-reply";
import { buildSystemPrompt, wrapCustomerMessages } from "./ai/prompt";
import { retrieveKnowledge } from "./kb/retrieve";
import type { ChatTurn, Provider } from "./ai/providers";
import type { BatchContext, BatchDeps } from "./batch";
import { appointmentDedupeKey, parseWorkflowState } from "./workflow";
import { KEY_EMAIL_INTERVAL_MS, type AiMode, type KeyStatus } from "./ai-keys";
import { billingEnforced, computeAccess, type SubscriptionRow } from "./billing/access";
import { decryptSecret } from "./crypto";
import { env } from "./env";
import { parseWorkflowSettings } from "./workflow-settings";
import { notifyOwner, raiseAlert, sendClientText } from "./supabase-deps";
import { supabaseAdmin } from "./supabase-admin";

const HISTORY_TURNS = 12;

// Production implementation of BatchDeps. The conversation row tells us which
// client it belongs to; every later query filters by that client_id.
export function supabaseBatchDeps(): BatchDeps {
  const db = supabaseAdmin();

  return {
    async claim(conversationId) {
      const { data, error } = await db.rpc("claim_batch", { p_conversation_id: conversationId });
      if (error) throw new Error(`claim_batch failed: ${error.message}`);
      return data === true;
    },

    async load(conversationId): Promise<BatchContext | null> {
      const { data: conv, error } = await db
        .from("conversations")
        .select("id, client_id, contact_id, handling, failed_answer_count, last_customer_message_at, workflow_state")
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(`conversation load failed: ${error.message}`);
      if (!conv) return null;
      const clientId: string = conv.client_id;

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

      const [client, contact, pendingRows, recent, replies, recentInbound, openAppt, openTickets, openLeads, subRow] = await Promise.all([
        db.from("clients")
          .select("id, name, wa_phone_number_id, ai_provider, ai_mode, ai_key_status, billing_exempt, business_info, business_hours, booking_link, kb_text, monthly_message_cap, workflow_settings")
          .eq("id", clientId).single(),
        db.from("contacts").select("id, phone, name").eq("client_id", clientId).eq("id", conv.contact_id).single(),
        db.from("pending_messages").select("id, message_id, created_at")
          .eq("client_id", clientId).eq("conversation_id", conversationId).order("created_at"),
        db.from("messages").select("id, direction, type, body, status, created_at")
          .eq("client_id", clientId).eq("conversation_id", conversationId)
          .order("created_at", { ascending: false }).limit(HISTORY_TURNS + 20),
        db.from("usage_events").select("id", { count: "exact", head: true })
          .eq("client_id", clientId).eq("kind", "reply").gte("created_at", monthStart),
        db.from("messages").select("id", { count: "exact", head: true })
          .eq("client_id", clientId).eq("conversation_id", conversationId)
          .eq("direction", "inbound").gte("created_at", hourAgo),
        db.from("appointments").select("status, reschedule_note")
          .eq("client_id", clientId).eq("conversation_id", conversationId).in("status", ["pending", "reschedule_requested"])
          .order("created_at", { ascending: false }).limit(10),
        db.from("tickets").select("id", { count: "exact", head: true })
          .eq("client_id", clientId).eq("contact_id", conv.contact_id).in("status", ["open", "in_progress", "waiting_on_customer"]),
        db.from("leads").select("id", { count: "exact", head: true })
          .eq("client_id", clientId).eq("contact_id", conv.contact_id).in("status", ["new", "qualified", "contacted", "proposal_sent", "negotiation"]),
        db.from("subscriptions").select("status, current_period_end, cancel_at_period_end, grace_ends_at").eq("client_id", clientId).maybeSingle(),
      ]);
      for (const r of [client, contact, pendingRows, recent, replies, recentInbound, openAppt, openTickets, openLeads, subRow]) {
        if (r.error) throw new Error(`batch load failed: ${r.error.message}`);
      }

      // Pending rows -> message text. Oldest first so the model sees the real order.
      const pendingMessageIds = new Set((pendingRows.data ?? []).map((p) => p.message_id as string));
      const byId = new Map((recent.data ?? []).map((m) => [m.id as string, m]));
      const missing = [...pendingMessageIds].filter((id) => !byId.has(id));
      if (missing.length) {
        const { data, error: e } = await db.from("messages").select("id, direction, type, body, status, created_at")
          .eq("client_id", clientId).in("id", missing);
        if (e) throw new Error(`pending message load failed: ${e.message}`);
        for (const m of data ?? []) byId.set(m.id as string, m);
      }
      const pending = (pendingRows.data ?? []).map((p) => {
        const m = byId.get(p.message_id as string);
        return { id: p.id as string, type: (m?.type as string) ?? "text", body: (m?.body as string | null) ?? null };
      });

      // History = recent messages that are not part of this batch, oldest first.
      const history: ChatTurn[] = (recent.data ?? [])
        .filter((m) => !pendingMessageIds.has(m.id as string) && m.body && m.status !== "blocked" && m.status !== "failed")
        .slice(0, HISTORY_TURNS)
        .reverse()
        .map((m) => m.direction === "inbound"
          ? { role: "user" as const, text: wrapCustomerMessages([m.body as string]) }
          : { role: "assistant" as const, text: m.body as string });

      const c = client.data!;
      // BYOK: this business's own key, decrypted only here, only for the length of this batch. It is never logged.
      let apiKey: string | null = null;
      if (c.ai_mode === "byok") {
        const { data: sec } = await db.from("client_secrets").select("ai_api_key_enc").eq("client_id", clientId).maybeSingle();
        if (sec?.ai_api_key_enc) {
          try {
            apiKey = decryptSecret(sec.ai_api_key_enc, env().ENCRYPTION_KEY);
          } catch {
            console.error("could not decrypt a stored AI credential", { clientId }); // never the value
          }
        }
      }
      return {
        client: {
          id: c.id, name: c.name, waPhoneNumberId: c.wa_phone_number_id,
          aiProvider: c.ai_provider as Provider, businessInfo: c.business_info,
          businessHours: c.business_hours, bookingLink: c.booking_link, kbText: c.kb_text,
          monthlyMessageCap: c.monthly_message_cap, workflow: parseWorkflowSettings(c.workflow_settings),
          ai: { mode: c.ai_mode as AiMode, apiKey, keyStatus: c.ai_key_status as KeyStatus },
          billing: computeAccess((subRow.data as SubscriptionRow) ?? null, { exempt: c.billing_exempt === true, enforced: billingEnforced(), now: new Date() }),
        },
        conversation: {
          id: conv.id, handling: conv.handling, failedAnswerCount: conv.failed_answer_count,
          lastCustomerMessageAt: conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null,
          workflowState: parseWorkflowState(conv.workflow_state),
        },
        open: {
          appointments: (openAppt.data ?? []).map((a) => ({ status: a.status as "pending" | "reschedule_requested", rescheduleNote: a.reschedule_note as string | null })),
          tickets: openTickets.count ?? 0,
          leads: openLeads.count ?? 0,
        },
        contact: { id: contact.data!.id, name: contact.data!.name },
        phone: contact.data!.phone,
        pending,
        history,
        repliesThisMonth: replies.count ?? 0,
        recentInboundCount: recentInbound.count ?? 0,
      };
    },

    async complete(conversationId, pendingIds) {
      const { data, error } = await db.rpc("complete_batch", {
        p_conversation_id: conversationId,
        p_pending_ids: pendingIds,
      });
      if (error) throw new Error(`complete_batch failed: ${error.message}`);
      return data === true;
    },

    async generate(ctx, customerLines, hasUnreadableMedia) {
      // Hybrid search over THIS client's documents for what the customer just wrote.
      const retrieved = await retrieveKnowledge(ctx.client.id, customerLines.join(" "));
      const platform = aiConfig();
      const { mode, apiKey } = ctx.client.ai;
      // BYOK: ONLY the business's own key, for ONLY its chosen provider. Both platform keys are blanked, so a missing
      // or wrong key can never fall back to the platform's (which would bill you for someone else's usage).
      const config = mode === "byok"
        ? { ...platform, geminiApiKey: ctx.client.aiProvider === "gemini" ? apiKey ?? undefined : undefined, openaiApiKey: ctx.client.aiProvider === "openai" ? apiKey ?? undefined : undefined }
        : platform;
      return generateReply({
        provider: ctx.client.aiProvider,
        config,
        system: buildSystemPrompt(ctx.client, retrieved, {
          today: new Date().toISOString().slice(0, 10),
          flowState: ctx.conversation.workflowState,
          open: ctx.open,
        }),
        history: ctx.history,
        userTurn: wrapCustomerMessages(customerLines, { hasUnreadableMedia }),
      });
    },

    async reportAiKeyProblem(clientId, problem, opts) {
      const now = new Date();
      if (opts?.markInvalid) {
        await db.from("clients").update({ ai_key_status: "invalid", ai_key_checked_at: now.toISOString() }).eq("id", clientId);
      }
      // Email at most once a day: the conditional update only succeeds for the call that wins the day.
      const cutoff = new Date(now.getTime() - KEY_EMAIL_INTERVAL_MS).toISOString();
      const { data } = await db.from("clients").update({ ai_key_notified_at: now.toISOString() })
        .eq("id", clientId).or(`ai_key_notified_at.is.null,ai_key_notified_at.lt.${cutoff}`).select("id");
      if (data?.length) await notifyOwner(clientId, { type: "ai_key_problem", problem });
    },

    sendText: (ctx, body) => sendClientText(ctx.client.id, ctx.client.waPhoneNumberId, ctx.phone, body),

    async saveReply(rec) {
      const { data, error } = await db.from("messages").insert({
        client_id: rec.clientId,
        conversation_id: rec.conversationId,
        direction: "outbound",
        sender: "bot",
        type: "text",
        body: rec.body,
        wa_message_id: rec.waMessageId,
        status: rec.status,
        error: rec.error ?? null,
        input_tokens: rec.usage?.inputTokens ?? null,
        output_tokens: rec.usage?.outputTokens ?? null,
      }).select("id").single();
      if (error) throw new Error(`saving outbound message failed: ${error.message}`);

      // One usage row per message that spent tokens: powers per-client usage and the monthly cap.
      if (rec.usage && rec.status === "sent") {
        const { error: uErr } = await db.from("usage_events").insert({
          client_id: rec.clientId, message_id: data.id, kind: "reply",
          provider: rec.provider, model: rec.model,
          input_tokens: rec.usage.inputTokens, output_tokens: rec.usage.outputTokens,
        });
        if (uErr) throw new Error(`saving usage failed: ${uErr.message}`);
      }
    },

    async createHandoff(clientId, conversationId, input) {
      const { data, error } = await db.rpc("create_handoff", {
        p_client_id: clientId, p_conversation_id: conversationId, p_source: input.source,
        p_reason: input.reason, p_summary: input.summary,
      });
      if (error) throw new Error(`create_handoff failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { created: row?.out_created === true };
    },

    async saveAppointment(clientId, ctx, a) {
      const { data, error } = await db.rpc("create_appointment", {
        p_client_id: clientId, p_conversation_id: ctx.conversation.id, p_contact_id: ctx.contact.id,
        p_customer_name: a.customerName, p_customer_phone: ctx.phone, p_purpose: a.purpose,
        p_preferred_date: a.preferredDate, p_preferred_time: a.preferredTime, p_timezone: a.timezone,
        p_appointment_type: a.appointmentType, p_notes: a.notes, p_dedupe_key: appointmentDedupeKey(a),
      });
      if (error) throw new Error(`create_appointment failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { created: row?.out_created === true };
    },

    async saveTicket(clientId, ctx, t) {
      const { data, error } = await db.rpc("create_ticket", {
        p_client_id: clientId, p_conversation_id: ctx.conversation.id, p_contact_id: ctx.contact.id,
        p_customer_name: t.customerName, p_customer_phone: ctx.phone, p_subject: t.subject, p_description: t.description,
        p_category: t.category, p_reference_info: t.referenceInfo, p_priority: t.priority, p_ai_summary: t.summary, p_dedupe_key: t.dedupeKey,
      });
      if (error) throw new Error(`create_ticket failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { created: row?.out_created === true };
    },

    async saveLead(clientId, ctx, l) {
      const { data, error } = await db.rpc("create_lead", {
        p_client_id: clientId, p_conversation_id: ctx.conversation.id, p_contact_id: ctx.contact.id,
        p_customer_name: l.customerName, p_customer_phone: ctx.phone, p_project_type: l.projectType, p_description: l.description,
        p_budget: l.budget, p_timeline: l.timeline, p_status: l.status, p_ai_summary: l.summary, p_dedupe_key: l.dedupeKey,
        p_requirements: l.requirements,
      });
      if (error) throw new Error(`create_lead failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { created: row?.out_created === true };
    },

    async updateConversation(clientId, conversationId, patch) {
      const { error } = await db.from("conversations").update({
        ...(patch.handling ? { handling: patch.handling } : {}),
        ...(patch.failedAnswerCount !== undefined ? { failed_answer_count: patch.failedAnswerCount } : {}),
        ...(patch.workflowState !== undefined ? { workflow_state: patch.workflowState } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", conversationId).eq("client_id", clientId);
      if (error) throw new Error(`conversation update failed: ${error.message}`);
    },

    async recordFailedUsage(clientId, usage, provider, model) {
      // Tokens spent on output we threw away still cost money; keep them visible.
      await db.from("usage_events").insert({
        client_id: clientId, kind: "reply_failed", provider, model,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      });
    },

    async applyContactDetails(clientId, contactId, details) {
      const { error } = await db.rpc("apply_contact_details", {
        p_client_id: clientId, p_contact_id: contactId, p_name: details.name, p_email: details.email,
      });
      if (error) throw new Error(`apply_contact_details failed: ${error.message}`);
    },

    async markLead(clientId, contactId) {
      const { data, error } = await db.rpc("mark_contact_lead", { p_client_id: clientId, p_contact_id: contactId });
      if (error) throw new Error(`mark_contact_lead failed: ${error.message}`);
      return data === true;
    },

    notifyOwner,

    async logUnanswered(clientId, conversationId, question) {
      const { error } = await db.from("unanswered_questions").insert({ client_id: clientId, conversation_id: conversationId, question });
      if (error) throw new Error(`logging unanswered question failed: ${error.message}`);
    },

    raiseAlert,

    async findDueBatches(limit) {
      const { data, error } = await db.rpc("find_due_batches", { p_limit: limit });
      if (error) throw new Error(`find_due_batches failed: ${error.message}`);
      return (data ?? []) as string[];
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
