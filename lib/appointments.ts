import { z } from "zod";

// Pure helpers for appointment requests (unit-tested). The same transition rules are enforced in SQL by
// public.set_appointment_status; this copy decides which buttons the page shows and what the customer is told.

type Tone = "brand" | "success" | "warn" | "danger" | "muted"; // same names as components/ui

export const APPOINTMENT_STATUSES = ["pending", "confirmed", "reschedule_requested", "rejected", "cancelled", "completed"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_ACTIONS = ["confirm", "reject", "reschedule", "cancel", "complete"] as const;
export type AppointmentAction = (typeof APPOINTMENT_ACTIONS)[number];

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: "Unconfirmed",
  confirmed: "Confirmed",
  reschedule_requested: "Reschedule",
  rejected: "Rejected",
  cancelled: "Cancelled",
  completed: "Completed",
};
export const STATUS_TONES: Record<AppointmentStatus, Tone> = {
  pending: "warn", confirmed: "success", reschedule_requested: "brand", rejected: "danger", cancelled: "muted", completed: "muted",
};

const ALLOWED: Record<AppointmentStatus, AppointmentAction[]> = {
  pending: ["confirm", "reject", "reschedule", "cancel"],
  reschedule_requested: ["confirm", "reject", "cancel"],
  confirmed: ["reschedule", "cancel", "complete"],
  rejected: [], cancelled: [], completed: [],
};
export const allowedActions = (s: AppointmentStatus): AppointmentAction[] => ALLOWED[s];

export function nextStatus(s: AppointmentStatus, a: AppointmentAction): AppointmentStatus | null {
  if (!ALLOWED[s].includes(a)) return null;
  return ({ confirm: "confirmed", reject: "rejected", reschedule: "reschedule_requested", cancel: "cancelled", complete: "completed" } as const)[a];
}

/** "2026-11-20 10am", "2026-11-20", "10am" or "" */
export const whenText = (date: string | null | undefined, time: string | null | undefined) =>
  [date, time].map((x) => x?.trim()).filter(Boolean).join(" ");

export type ApptLike = { status: AppointmentStatus; scheduled_date: string | null; preferred_date: string | null };

/** Confirmed and not in the past (by its scheduled date, else its preferred date; no date at all counts as upcoming). */
export function isUpcoming(a: ApptLike, today: string): boolean {
  if (a.status !== "confirmed") return false;
  const d = a.scheduled_date ?? a.preferred_date;
  return !d || d >= today;
}

export function overview(rows: ApptLike[], today: string) {
  return {
    pending: rows.filter((r) => r.status === "pending" || r.status === "reschedule_requested").length,
    upcoming: rows.filter((r) => isUpcoming(r, today)).length,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    closed: rows.filter((r) => r.status === "rejected" || r.status === "cancelled").length,
  };
}

// ---- what the customer is told. Never includes internal notes. ----

const trimNote = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

export function customerMessage(action: Exclude<AppointmentAction, "complete">, a: { purpose: string; when: string; note?: string | null }, business: string): string {
  const note = trimNote(a.note);
  switch (action) {
    case "confirm":
      return `Good news! Your appointment with ${business} for ${a.purpose}${a.when ? ` is confirmed for ${a.when}` : " is confirmed"}. We look forward to seeing you. If anything changes, just message us here.`;
    case "reject":
      return `Sorry, we can't offer the appointment you asked for (${a.purpose}).${note ? ` ${note}` : ""} Please message us if you'd like to try another day or time.`;
    case "reschedule":
      return `${business} would like to reschedule your appointment for ${a.purpose}. ${note ? `Suggested: ${note}. ` : ""}Please reply and tell us if that works for you, or suggest another time.`;
    case "cancel":
      return `Your appointment with ${business} for ${a.purpose}${a.when ? ` (${a.when})` : ""} has been cancelled. Message us any time if you'd like to book again.`;
  }
}

// ---- form validation (dashboard actions) ----
const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // Date gives "Invalid Date" for 2026-02-31: never throw
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "not a real date");

export const appointmentFormSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(APPOINTMENT_ACTIONS),
  date: z.union([z.literal(""), isoDate]).optional(),
  time: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Why this action cannot go ahead with the details given, or null. Reschedule needs the alternative. */
export function formProblem(action: AppointmentAction, f: { date?: string; time?: string; note?: string }): string | null {
  if (action === "reschedule" && !f.note && !f.date && !f.time) return "Tell the customer what you suggest instead.";
  return null;
}

/** The alternative the owner typed, as one line for the customer. */
export const rescheduleNote = (f: { date?: string; time?: string; note?: string }) =>
  [whenText(f.date, f.time), f.note?.trim()].filter(Boolean).join(" - ");

// ---- editing an appointment by hand (any field, any status)

/** The customer message that goes with a status, when there is one (pending and completed have none). */
export const statusMessageAction = (s: AppointmentStatus): Exclude<AppointmentAction, "complete"> | null =>
  s === "confirmed" ? "confirm" : s === "rejected" ? "reject" : s === "reschedule_requested" ? "reschedule" : s === "cancelled" ? "cancel" : null;

const optionalDate = z.union([z.literal(""), isoDate]);
export const appointmentEditSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(APPOINTMENT_STATUSES),
  customer_name: z.string().trim().max(100),
  purpose: z.string().trim().min(1).max(300),
  preferred_date: optionalDate,
  preferred_time: z.string().trim().max(60),
  scheduled_date: optionalDate,
  scheduled_time: z.string().trim().max(60),
  appointment_type: z.enum(["", "online", "in_person"]),
  timezone: z.string().trim().max(60),
  note: z.string().trim().max(500),          // the reason or alternative shown to the customer with a reject / reschedule message
  notify: z.boolean(),
});

/**
 * A link that opens WhatsApp with the message already typed, so the owner only presses send from their own phone (the WhatsApp
 * Business app). It is not an API message: no template, no 24-hour rule, no Meta API charge. Null if the number is not usable.
 */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text.slice(0, 1500))}`;
}
