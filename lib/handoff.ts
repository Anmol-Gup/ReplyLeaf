import { z } from "zod";
type Tone = "brand" | "success" | "warn" | "danger" | "muted"; // same names as components/ui

// Pure helpers for human handoff (unit-tested). The same rules are enforced in SQL by
// public.set_handoff_status; this copy decides which buttons the page shows.

export const HANDOFF_STATUSES = ["requested", "assigned", "human_active", "resolved"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_SOURCES = ["customer_request", "failed_answers", "booking_without_link", "owner", "action_failed"] as const;
export type HandoffSource = (typeof HANDOFF_SOURCES)[number];

export const HANDOFF_ACTIONS = ["assign", "take_over", "resolve", "resume_ai"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export const STATUS_LABELS: Record<HandoffStatus, string> = {
  requested: "Waiting for you",
  assigned: "Assigned",
  human_active: "You are handling it",
  resolved: "Resolved",
};
export const STATUS_TONES: Record<HandoffStatus, Tone> = { requested: "danger", assigned: "warn", human_active: "brand", resolved: "success" };

export const SOURCE_LABELS: Record<HandoffSource, string> = {
  customer_request: "The customer asked for a person, is upset, or needs something sensitive",
  failed_answers: "The assistant could not answer twice in a row",
  booking_without_link: "The customer wants to book and no booking link is set",
  owner: "Taken over by the owner",
  action_failed: "The assistant could not save the customer's request",
};

/** The five conversation states: how the assistant switch and the handoff record read together. */
export type ConversationState = "ai_active" | "handoff_requested" | "assigned" | "human_active" | "resolved";
export function conversationState(handling: string, handoff: HandoffStatus | null): ConversationState {
  if (handoff === "requested") return "handoff_requested";
  if (handoff === "assigned") return "assigned";
  if (handoff === "human_active") return "human_active";
  if (handling === "bot") return "ai_active";
  return handoff === "resolved" ? "resolved" : "human_active"; // paused with no open handoff: still a person's chat
}

export const isOpen = (s: HandoffStatus) => s !== "resolved";

/** Which actions make sense for a status (mirrors set_handoff_status). */
export function allowedActions(s: HandoffStatus): HandoffAction[] {
  if (s === "requested" || s === "assigned") return ["assign", "take_over", "resolve", "resume_ai"];
  if (s === "human_active") return ["assign", "resolve", "resume_ai"];
  return [];
}

/** The status after an action, or null when the move is not allowed. */
export function nextStatus(s: HandoffStatus, action: HandoffAction): HandoffStatus | null {
  if (!allowedActions(s).includes(action)) return null;
  if (action === "assign") return s === "requested" ? "assigned" : s;
  if (action === "take_over") return "human_active";
  return "resolved";
}

/** A name or email typed by the owner: trimmed, no control characters, 1-100 characters. */
export function cleanAssignee(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return v.length >= 1 && v.length <= 100 ? v : null;
}

export const cleanNote = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\u0000/g, "").trim();
  return v.length <= 2000 ? v : null; // an empty note clears it
};

export const handoffFormSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(HANDOFF_ACTIONS),
});

/** The model's one- or two-sentence summary, trimmed and capped, or a fallback built from the last message. */
export function summaryOrFallback(summary: string | null | undefined, lastMessage: string): string {
  const s = summary?.replace(/\s+/g, " ").trim();
  if (s) return s.slice(0, 400);
  const m = lastMessage.replace(/\s+/g, " ").trim();
  return m ? `Last message: ${m.slice(0, 300)}` : "No summary available.";
}
