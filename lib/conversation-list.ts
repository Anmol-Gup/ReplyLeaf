import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSATION_FILTERS, compareConversations, conversationStateOf, isUnread, matchesFilter, type ConversationFilter, type ConvState, type OpenHandoff } from "./conversation-state";
import { clip } from "./dashboard";
import { isWithinWindow } from "./whatsapp/window";

export type ConversationItem = {
  id: string; name: string; phone: string; preview: string; lastAt: string | null; state: ConvState; unread: boolean; windowOpen: boolean;
};
const LIMIT = 150;
const EMPTY_COUNTS: Record<ConversationFilter, number> = { all: 0, ai: 0, waiting: 0, assigned: 0, unread: 0 };

/** `%`, `_` and `\` are wildcards in LIKE: a search for "50%" must match the text, not everything. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// The list, read with the person's own (RLS) client: only their business. Search matches the customer's name, number or any message text.
export async function loadConversationList(db: SupabaseClient, userId: string, opts: { filter: ConversationFilter; q: string }): Promise<{ items: ConversationItem[]; counts: Record<ConversationFilter, number>; error: boolean }> {
  const q = opts.q.trim().slice(0, 80);
  const { data: convs, error } = await db.from("conversations")
    .select("id, contact_id, handling, last_customer_message_at, updated_at").order("updated_at", { ascending: false }).limit(LIMIT);
  if (error) return { items: [], counts: EMPTY_COUNTS, error: true };
  const ids = (convs ?? []).map((c) => c.id as string);
  if (ids.length === 0) return { items: [], counts: EMPTY_COUNTS, error: false };

  const [contacts, recent, open, reads, byText, byPerson] = await Promise.all([
    db.from("contacts").select("id, name, phone").in("id", (convs ?? []).map((c) => c.contact_id)),
    db.from("messages").select("conversation_id, direction, sender, body, type, created_at").in("conversation_id", ids).order("created_at", { ascending: false }).limit(600),
    db.from("handoff_requests").select("conversation_id, status, assigned_user_id").neq("status", "resolved"),
    db.from("conversation_reads").select("conversation_id, read_at").eq("user_id", userId).in("conversation_id", ids),
    q ? db.from("messages").select("conversation_id").ilike("body", likePattern(q)).in("conversation_id", ids).limit(500) : Promise.resolve({ data: [] as { conversation_id: string }[] }),
    q ? db.from("contacts").select("id").or(`name.ilike.${likePattern(q).replace(/[,()]/g, " ")},phone.ilike.${likePattern(q.replace(/^\+/, "")).replace(/[,()]/g, " ")}`).limit(200) : Promise.resolve({ data: [] as { id: string }[] }),
  ]);
  const contactOf = new Map((contacts.data ?? []).map((c) => [c.id as string, c]));
  const last = new Map<string, { direction: string; sender: string; body: string | null; type: string; created_at: string }>();
  for (const m of recent.data ?? []) if (!last.has(m.conversation_id as string)) last.set(m.conversation_id as string, m as never);
  const openOf = new Map((open.error ? [] : open.data ?? []).map((h) => [h.conversation_id as string, h as unknown as OpenHandoff]));
  const readAt = new Map((reads.error ? [] : reads.data ?? []).map((r) => [r.conversation_id as string, r.read_at as string]));
  const hitConv = new Set((byText.data ?? []).map((r) => r.conversation_id as string));
  const hitContact = new Set((byPerson.data ?? []).map((r) => r.id as string));

  const items: ConversationItem[] = [];
  for (const c of convs ?? []) {
    if (q && !hitConv.has(c.id as string) && !hitContact.has(c.contact_id as string)) continue;
    const ct = contactOf.get(c.contact_id as string);
    const lm = last.get(c.id as string);
    const state = conversationStateOf(c.handling as string, openOf.get(c.id as string) ?? null, userId);
    const unread = isUnread(c.last_customer_message_at as string | null, readAt.get(c.id as string) ?? null);
    const who = lm?.direction === "outbound" ? (lm.sender === "human" ? "You: " : "Assistant: ") : "";
    items.push({
      id: c.id as string, name: (ct?.name as string) || `+${ct?.phone ?? ""}`, phone: String(ct?.phone ?? ""),
      preview: lm ? who + (lm.body ? clip(lm.body, 60) : `[${lm.type} message]`) : "",
      lastAt: lm?.created_at ?? (c.updated_at as string), state, unread,
      windowOpen: isWithinWindow(c.last_customer_message_at ? new Date(c.last_customer_message_at as string) : null),
    });
  }
  // The pill counts use the same rows (after search), so a count always matches what the pill shows.
  const counts = { ...EMPTY_COUNTS };
  for (const f of CONVERSATION_FILTERS) counts[f] = items.filter((i) => matchesFilter(f, i.state, i.unread)).length;
  return { items: items.filter((i) => matchesFilter(opts.filter, i.state, i.unread)).sort(compareConversations), counts, error: false };
}
