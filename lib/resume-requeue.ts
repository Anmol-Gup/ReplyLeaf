import { supabaseAdmin } from "./supabase-admin";
import { isWithinWindow } from "./whatsapp/window";

// "Resume assistant" hands a chat back to the AI. The database function clears the queue (so old, stale messages are never answered),
// which also meant a question the customer asked WHILE a person was handling the chat was never answered by the AI afterwards.
// These helpers put just those waiting messages back: the customer messages at the END of the chat that nobody has replied to yet.

/** From the newest message backwards: the ids of the customer messages that come after the last reply (human or assistant). Newest message first in, oldest first out. */
export function unansweredCustomerIds(newestFirst: { id: string; direction: string }[], max = 10): string[] {
  const ids: string[] = [];
  for (const m of newestFirst) {
    if (m.direction !== "inbound") break; // a reply (yours or the assistant's) closes everything before it
    ids.push(m.id);
    if (ids.length >= max) break;
  }
  return ids.reverse();
}

/**
 * Queues the unanswered customer messages of a chat the assistant has just been handed back. Returns true when something was queued
 * (the caller then runs the batch). Nothing is queued when the 24-hour WhatsApp window has closed (a free-form reply could not be
 * sent anyway), when the chat is not with the assistant, or when the last message is already a reply.
 */
export async function requeueUnanswered(clientId: string, conversationId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("handling, last_customer_message_at").eq("id", conversationId).eq("client_id", clientId).maybeSingle();
  if (!conv || conv.handling !== "bot") return false;
  if (!isWithinWindow(conv.last_customer_message_at ? new Date(conv.last_customer_message_at as string) : null)) return false;
  const { data: msgs } = await db.from("messages").select("id, direction").eq("conversation_id", conversationId).eq("client_id", clientId).order("created_at", { ascending: false }).limit(10);
  const ids = unansweredCustomerIds((msgs ?? []) as { id: string; direction: string }[]);
  if (ids.length === 0) return false;
  const { error } = await db.from("pending_messages").upsert(ids.map((message_id) => ({ client_id: clientId, conversation_id: conversationId, message_id })), { onConflict: "message_id", ignoreDuplicates: true });
  if (error) { console.error("requeue after resume failed", error.message); return false; }
  const { error: dueErr } = await db.from("conversations").update({ batch_due_at: new Date().toISOString() }).eq("id", conversationId).eq("client_id", clientId);
  return !dueErr;
}
