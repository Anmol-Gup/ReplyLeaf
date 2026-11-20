import { z } from "zod";

// Pure helpers for support tickets (unit-tested).

type Tone = "brand" | "success" | "warn" | "danger" | "muted"; // same names as components/ui

export const TICKET_STATUSES = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_LABELS: Record<TicketStatus, string> = {
  open: "Open", in_progress: "In progress", waiting_on_customer: "Waiting on customer", resolved: "Resolved", closed: "Closed",
};
export const TICKET_TONES: Record<TicketStatus, Tone> = {
  open: "danger", in_progress: "warn", waiting_on_customer: "brand", resolved: "success", closed: "muted",
};

export const isOpenTicket = (s: TicketStatus) => s === "open" || s === "in_progress" || s === "waiting_on_customer";
export const isDone = (s: TicketStatus) => s === "resolved" || s === "closed";

/** A short, readable reference the owner and customer can quote: "T-1A2B3C". */
export const ticketRef = (id: string) => `T-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

export const ticketFormSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(["normal", "high"]).optional(), // left out = unchanged
  assigned_to: z.string().max(200),
  notes: z.string().max(4000),
  message: z.string().max(1000), // optional text for the customer when the ticket is resolved or closed
});

/** The name or email typed into the assignee box: trimmed, no control characters, 100 characters at most. */
export function cleanAssignedTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return v && v.length <= 100 ? v : null;
}

/** resolved_at for a status change: set when it becomes done, cleared when it is reopened, kept otherwise. */
export function resolvedAtFor(next: TicketStatus, prev: TicketStatus, prevResolvedAt: string | null, now: Date): string | null {
  if (isDone(next)) return isDone(prev) && prevResolvedAt ? prevResolvedAt : now.toISOString();
  return null;
}

/** What the customer is told when the owner closes the loop. Never includes internal notes. */
export function resolutionMessage(business: string, subject: string, ref: string, note: string): string {
  const extra = note.replace(/\s+/g, " ").trim().slice(0, 600);
  return `Update from ${business} on your issue "${subject}" (${ref}): it has been marked as resolved.${extra ? ` ${extra}` : ""} If anything is still wrong, just reply here and we'll look again.`;
}

export function ticketOverview(rows: { status: TicketStatus; priority: string }[]) {
  return {
    open: rows.filter((r) => r.status === "open").length,
    inProgress: rows.filter((r) => r.status === "in_progress" || r.status === "waiting_on_customer").length,
    urgent: rows.filter((r) => isOpenTicket(r.status) && r.priority === "high").length,
    done: rows.filter((r) => isDone(r.status)).length,
  };
}

export const PRIORITIES = ["normal", "high"] as const;
export type TicketPriority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<TicketPriority, string> = { normal: "Normal", high: "Urgent" };
