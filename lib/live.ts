import type { SupabaseClient } from "@supabase/supabase-js";
import { isUnread } from "./conversation-state";
import type { LivePayload } from "./notifications";

// What the dashboard polls: recent notifications, the unread count and the sidebar counts. Everything is read with the person's own
// (RLS) client, so a person only ever sees their business and their own notifications. A database without migration 0026 gives zeros.
export async function loadLive(db: SupabaseClient, userId: string): Promise<LivePayload> {
  const [notes, unreadRes, open, convs, reads] = await Promise.all([
    db.from("notifications").select("id, kind, title, body, link, read_at, created_at").order("created_at", { ascending: false }).limit(20),
    db.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
    db.from("handoff_requests").select("status, assigned_user_id").neq("status", "resolved"),
    db.from("conversations").select("id, last_customer_message_at").not("last_customer_message_at", "is", null).order("last_customer_message_at", { ascending: false }).limit(300),
    db.from("conversation_reads").select("conversation_id, read_at").eq("user_id", userId).limit(1000),
  ]);
  const openRows = (open.error ? [] : open.data ?? []) as { assigned_user_id: string | null }[];
  const readAt = new Map((reads.error ? [] : reads.data ?? []).map((r) => [r.conversation_id as string, r.read_at as string]));
  const unreadChats = (convs.data ?? []).filter((c) => isUnread(c.last_customer_message_at as string, readAt.get(c.id as string) ?? null)).length;
  return {
    notifications: (notes.error ? [] : notes.data ?? []).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.read_at !== null, created_at: n.created_at })),
    unread: unreadRes.error ? 0 : unreadRes.count ?? 0,
    counts: { waiting: openRows.filter((r) => !r.assigned_user_id).length, mine: openRows.filter((r) => r.assigned_user_id === userId).length, unreadChats: reads.error ? 0 : unreadChats },
  };
}
