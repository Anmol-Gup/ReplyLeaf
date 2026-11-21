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

/** What the owner can change on a ticket. The assignee is a team member's user id (checked on the server), or "" for unassigned. */
export const ticketFormSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(["low", "normal", "high"]).optional(), // left out = unchanged
  category: z.string().max(60).optional(),                 // left out = unchanged; "" clears it
  assigned_user_id: z.union([z.literal(""), z.string().uuid()]).optional(), // left out = unchanged; "" = unassigned
  description: z.string().max(2000).transform((v) => v.trim()).pipe(z.string().min(1)).optional(), // left out = unchanged
  message: z.string().max(1000), // optional line for the customer, sent only when "Notify customer" is ticked
});

/** A private note: any number of them, each kept with its author and time. */
export const ticketNoteSchema = z.object({
  id: z.string().uuid(),
  body: z.string().transform((v) => v.replace(/\u0000/g, "").trim()).pipe(z.string().min(1).max(4000)),
});

// ---- status changes. Resolved and Closed are different: Resolved = the issue is addressed, Closed = the ticket is finished.
// Each status lists where it can go next; the page offers only these and the server enforces them.
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["in_progress", "waiting_on_customer", "resolved", "closed"],
  in_progress: ["waiting_on_customer", "resolved", "closed"],
  waiting_on_customer: ["in_progress", "resolved", "closed"],
  resolved: ["closed", "in_progress"],   // finish it, or reopen it
  closed: ["in_progress"],               // reopen
};
/** The statuses a ticket in this status may be set to, including the current one (saving without changing it is fine). */
export const allowedStatuses = (current: TicketStatus): TicketStatus[] => [current, ...TRANSITIONS[current]];
export const canMoveTicket = (from: TicketStatus, to: TicketStatus) => from === to || TRANSITIONS[from].includes(to);

/** Offered in the category list (the business's own categories from Settings replace these). Never applied to a ticket on its own. */
export const DEFAULT_CATEGORIES = ["Technical issue", "Billing", "Delivery", "Account access", "Product issue", "Other"];
/** The category choices for one ticket: the business's list (or the defaults), plus the ticket's own category if it is not in it. */
export function categoryOptions(configured: string[], current: string | null | undefined): string[] {
  const list = configured.length ? configured : DEFAULT_CATEGORIES;
  const cur = current?.trim();
  return cur && !list.some((c) => c.toLowerCase() === cur.toLowerCase()) ? [...list, cur] : list;
}
export const cleanCategory = (raw: unknown): string | null => {
  const v = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return v || null;
};

// ---- the activity timeline
export const TICKET_EVENT_KINDS = ["created", "status", "priority", "category", "assigned", "note", "notification", "resolved", "closed"] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

/** One line describing an event. `detail` holds small facts only (old and new values), never note text. */
export function describeTicketEvent(kind: string, d: Record<string, unknown>): string {
  const s = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
  const status = (v: string | null) => (v && (TICKET_STATUSES as readonly string[]).includes(v) ? TICKET_LABELS[v as TicketStatus] : v ?? "none");
  const prio = (v: string | null) => (v ? PRIORITY_LABELS[priorityOf(v)] : "none");
  switch (kind) {
    case "created": return "Ticket created";
    case "status": return `Status changed from ${status(s("from"))} to ${status(s("to"))}`;
    case "priority": return `Priority changed from ${prio(s("from"))} to ${prio(s("to"))}`;
    case "category": return s("to") ? `Category set to ${s("to")}${s("from") ? ` (was ${s("from")})` : ""}` : "Category cleared";
    case "assigned": return s("to_label") ? (s("from_label") ? `Reassigned from ${s("from_label")} to ${s("to_label")}` : `Assigned to ${s("to_label")}`) : `Unassigned${s("from_label") ? ` (was ${s("from_label")})` : ""}`;
    case "note": return "Internal note added";
    case "resolved": return "Ticket resolved";
    case "closed": return "Ticket closed";
    case "notification": return "Customer notification";
    default: return "Update";
  }
}

/** What really happened to a customer notification, in plain words. `deliveryStatus` is WhatsApp's own report for the message, when we have it. */
export function notificationOutcome(d: Record<string, unknown>, deliveryStatus: string | null): { label: string; tone: "success" | "warn" | "danger" | "muted" } {
  const channel = d.channel;
  if (channel === "email") return { label: "Sent by email", tone: "success" };
  if (channel === "whatsapp") {
    if (deliveryStatus === "delivered" || deliveryStatus === "read") return { label: "Delivered on WhatsApp", tone: "success" };
    if (deliveryStatus === "failed") return { label: "Failed: WhatsApp could not deliver it", tone: "danger" };
    return { label: "Sent to WhatsApp (delivery not confirmed yet)", tone: "warn" }; // accepted by WhatsApp; not claimed as delivered
  }
  if (channel === "failed") return { label: "Failed: it could not be sent", tone: "danger" };
  return { label: "Not sent: the 24-hour WhatsApp window is closed and there is no email on file", tone: "muted" };
}

/** The customer-facing text for a status update. Only the status and the optional line the owner typed: never internal notes. */
export function statusUpdateMessage(business: string, subject: string, ref: string, status: TicketStatus, line: string): string {
  const extra = line.replace(/\s+/g, " ").trim().slice(0, 600);
  const head = `Update from ${business} on your issue "${subject}" (${ref}):`;
  switch (status) {
    case "resolved": return `${head} it has been marked as resolved.${extra ? ` ${extra}` : ""} If anything is still wrong, just reply here and we'll look again.`;
    case "closed": return `${head} this ticket is now closed.${extra ? ` ${extra}` : ""} If you need anything else, just message us here.`;
    case "waiting_on_customer": return `${head} we need a little more information from you.${extra ? ` ${extra}` : ""} Please reply here when you can.`;
    case "in_progress": return `${head} our team is working on it.${extra ? ` ${extra}` : ""}`;
    default: return `${head} it is open and waiting for our team.${extra ? ` ${extra}` : ""}`;
  }
}

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

// "normal" is the stored value for Medium. The assistant only ever sets normal or high (when the customer says it is urgent); Low is the owner's.
export const PRIORITIES = ["low", "normal", "high"] as const;
export type TicketPriority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", normal: "Medium", high: "High" };

/** A stored priority as one of the three levels (anything unexpected counts as Medium). */
export const priorityOf = (p: string | null | undefined): TicketPriority => (p === "low" || p === "high" ? p : "normal");
