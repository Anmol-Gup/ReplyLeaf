import { aiConfig } from "./ai/config";
import { generateReply } from "./ai/generate-reply";
import { buildSystemPrompt, wrapCustomerMessages } from "./ai/prompt";
import { retrieveKnowledge } from "./kb/retrieve";
import type { ChatTurn, Provider } from "./ai/providers";
import type { BatchContext, BatchDeps } from "./batch";
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
        .select("id, client_id, contact_id, handling, failed_answer_count, last_customer_message_at")
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(`conversation load failed: ${error.message}`);
      if (!conv) return null;
      const clientId: string = conv.client_id;

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

      const [client, contact, pendingRows, recent, replies, recentInbound] = await Promise.all([
        db.from("clients")
          .select("id, name, wa_phone_number_id, ai_provider, business_info, business_hours, booking_link, kb_text, monthly_message_cap")
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
      ]);
      for (const r of [client, contact, pendingRows, recent, replies, recentInbound]) {
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
      return {
        client: {
          id: c.id, name: c.name, waPhoneNumberId: c.wa_phone_number_id,
          aiProvider: c.ai_provider as Provider, businessInfo: c.business_info,
          businessHours: c.business_hours, bookingLink: c.booking_link, kbText: c.kb_text,
          monthlyMessageCap: c.monthly_message_cap,
        },
        conversation: {
          id: conv.id, handling: conv.handling, failedAnswerCount: conv.failed_answer_count,
          lastCustomerMessageAt: conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null,
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
      return generateReply({
        provider: ctx.client.aiProvider,
        config: aiConfig(),
        system: buildSystemPrompt(ctx.client, retrieved),
        history: ctx.history,
        userTurn: wrapCustomerMessages(customerLines, { hasUnreadableMedia }),
      });
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

    async updateConversation(clientId, conversationId, patch) {
      const { error } = await db.from("conversations").update({
        ...(patch.handling ? { handling: patch.handling } : {}),
        ...(patch.failedAnswerCount !== undefined ? { failed_answer_count: patch.failedAnswerCount } : {}),
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

    async saveBookingRequest(clientId, contactId, conversationId, b) {
      const { data, error } = await db.rpc("save_booking_request", {
        p_client_id: clientId, p_contact_id: contactId, p_conversation_id: conversationId,
        p_service: b.service, p_preferred_time: b.preferredTime, p_name: b.name,
      });
      if (error) throw new Error(`save_booking_request failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { created: row.out_created === true };
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
