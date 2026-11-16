import { STATUS_LABELS as APPT_LABELS, STATUS_TONES as APPT_TONES, type AppointmentStatus, whenText } from "./appointments";
import { STATUS_LABELS as HANDOFF_LABELS, STATUS_TONES as HANDOFF_TONES, type HandoffStatus } from "./handoff";
import { LEAD_LABELS, LEAD_TONES, type LeadStatus } from "./leads";
import { TICKET_LABELS, TICKET_TONES, ticketRef, type TicketStatus } from "./tickets";

// One customer's activity across every kind of record, newest first (shown on the contact page). Pure and unit-tested.
export type TimelineItem = {
  kind: "lead" | "appointment" | "ticket" | "handoff";
  id: string; title: string; detail: string; statusLabel: string; tone: "brand" | "success" | "warn" | "danger" | "muted";
  href: string; at: string; open: boolean;
};

type Raw = {
  leads: { id: string; project_type: string; budget: string | null; status: LeadStatus; created_at: string }[];
  appointments: { id: string; purpose: string; preferred_date: string | null; preferred_time: string | null; scheduled_date: string | null; scheduled_time: string | null; status: AppointmentStatus; created_at: string }[];
  tickets: { id: string; subject: string; priority: string; status: TicketStatus; created_at: string }[];
  handoffs: { id: string; conversation_id: string; reason: string | null; status: HandoffStatus; created_at: string }[];
};

export function buildTimeline(r: Raw): TimelineItem[] {
  const items: TimelineItem[] = [
    ...r.leads.map((l): TimelineItem => ({
      kind: "lead", id: l.id, title: `Project enquiry: ${l.project_type}`, detail: l.budget ? `Budget ${l.budget}` : "",
      statusLabel: LEAD_LABELS[l.status], tone: LEAD_TONES[l.status], href: `/dashboard/leads/${l.id}`, at: l.created_at,
      open: l.status !== "won" && l.status !== "lost",
    })),
    ...r.appointments.map((a): TimelineItem => ({
      kind: "appointment", id: a.id, title: `Appointment: ${a.purpose}`, detail: whenText(a.scheduled_date ?? a.preferred_date, a.scheduled_time ?? a.preferred_time),
      statusLabel: APPT_LABELS[a.status], tone: APPT_TONES[a.status], href: `/dashboard/appointments/${a.id}`, at: a.created_at,
      open: a.status === "pending" || a.status === "reschedule_requested" || a.status === "confirmed",
    })),
    ...r.tickets.map((t): TimelineItem => ({
      kind: "ticket", id: t.id, title: `Ticket ${ticketRef(t.id)}: ${t.subject}`, detail: t.priority === "high" ? "Urgent" : "",
      statusLabel: TICKET_LABELS[t.status], tone: TICKET_TONES[t.status], href: `/dashboard/tickets/${t.id}`, at: t.created_at,
      open: t.status === "open" || t.status === "in_progress" || t.status === "waiting_on_customer",
    })),
    ...r.handoffs.map((h): TimelineItem => ({
      kind: "handoff", id: h.id, title: "Handed to a person", detail: h.reason ?? "",
      statusLabel: HANDOFF_LABELS[h.status], tone: HANDOFF_TONES[h.status], href: `/dashboard/conversations/${h.conversation_id}`, at: h.created_at,
      open: h.status !== "resolved",
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
