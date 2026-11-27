// One conversation, one clear state, from the point of view of the person looking at it (pure, unit-tested).
// "Waiting" = a handoff is open and nobody has it. The assistant is silent in every state except "ai".

export type ConvState = "ai" | "waiting" | "mine" | "other";
export type OpenHandoff = { status: string; assigned_user_id: string | null; source?: string } | null;

export function conversationStateOf(handling: string, open: OpenHandoff, me: string): ConvState {
  if (open && open.assigned_user_id) return open.assigned_user_id === me ? "mine" : "other";
  if (open) return "waiting";
  // Taken over with no handoff record (older data): treat the person looking as the handler rather than locking everyone out.
  return handling === "human_active" ? "mine" : "ai";
}

export const STATE_LABELS: Record<ConvState, string> = {
  ai: "AI handling", waiting: "Waiting for human", mine: "Assigned to you", other: "Assigned to another agent",
};
export const STATE_TONES: Record<ConvState, "brand" | "success" | "warn" | "danger" | "muted"> = {
  ai: "muted", waiting: "danger", mine: "success", other: "brand",
};

/** What the person may do: the one button in the header and whether the composer is open. Only the assignee may reply. */
export function conversationActions(state: ConvState, open: OpenHandoff = null): { button: "take_over" | "resume_ai" | null; canReply: boolean } {
  switch (state) {
    // The chat is paused because the owner replied from the WhatsApp Business app (source "owner"): nobody needs to take it over here,
    // the useful action is to hand it back to the assistant. The label stays "Waiting for human" until someone does.
    case "waiting": return open?.source === "owner" ? { button: "resume_ai", canReply: false } : { button: "take_over", canReply: false };
    case "ai": return { button: "take_over", canReply: false };
    case "mine": return { button: "resume_ai", canReply: true };
    case "other": return { button: null, canReply: false };
  }
}

export const CONVERSATION_FILTERS = ["all", "ai", "waiting", "assigned", "unread"] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];
export const FILTER_LABELS: Record<ConversationFilter, string> = { all: "All", ai: "AI handling", waiting: "Waiting for human", assigned: "Assigned", unread: "Unread" };

export function matchesFilter(f: ConversationFilter, state: ConvState, unread: boolean): boolean {
  switch (f) {
    case "all": return true;
    case "ai": return state === "ai";
    case "waiting": return state === "waiting";
    case "assigned": return state === "mine" || state === "other";
    case "unread": return unread;
  }
}

/** Waiting chats first (they need someone), then by latest activity. */
export function compareConversations(a: { state: ConvState; lastAt: string | null }, b: { state: ConvState; lastAt: string | null }): number {
  const wa = a.state === "waiting" ? 0 : 1, wb = b.state === "waiting" ? 0 : 1;
  if (wa !== wb) return wa - wb;
  return (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
}

/** Unread for one person: the customer wrote after they last opened the chat (never opened = unread if the customer ever wrote). */
export function isUnread(lastCustomerAt: string | null, readAt: string | null): boolean {
  if (!lastCustomerAt) return false;
  return !readAt || lastCustomerAt > readAt;
}
