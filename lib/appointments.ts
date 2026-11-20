import { z } from "zod";
import { parseClockTime, todayInZone } from "./workflow";

// Pure helpers for appointment requests (unit-tested).
//
// How appointments work: the assistant collects the details (what, preferred date and time, notes). The owner then talks to the
// customer themselves, and afterwards sets the status here by hand. Nothing is sent to the customer from this page.

type Tone = "brand" | "success" | "warn" | "danger" | "muted"; // same names as components/ui

// The database accepts all six; older records may still carry "reschedule_requested" or "rejected".
export const APPOINTMENT_STATUSES = ["pending", "confirmed", "reschedule_requested", "rejected", "cancelled", "completed"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** The statuses the owner picks from. An older record with another status still shows it, so nothing is hidden. */
export const OWNER_STATUSES = ["pending", "confirmed", "completed", "cancelled"] as const;

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

/** "2026-11-20 10am", "2026-11-20", "10am" or "" */
export const whenText = (date: string | null | undefined, time: string | null | undefined) =>
  [date, time].map((x) => x?.trim()).filter(Boolean).join(" ");

export type ApptLike = { status: AppointmentStatus; scheduled_date: string | null; preferred_date: string | null };

/** Confirmed and not in the past (by its agreed date, else its preferred date; no date at all counts as upcoming). */
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

// ---- updating an appointment (dashboard action)
const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // Date gives "Invalid Date" for 2026-02-31: never throw
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "not a real date");

/** What the owner can change: the status, the date and time they agreed with the customer, the customer's email (optional) and a private note. */
export const appointmentUpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(APPOINTMENT_STATUSES),
  scheduled_date: z.union([z.literal(""), isoDate]),
  scheduled_time: z.string().trim().max(60),
  customer_email: z.union([z.literal(""), z.string().trim().email().max(200)]), // optional; the owner fills it in
  notes: z.string().max(2000).transform((v) => v.replace(/\u0000/g, "").trim()),
});

export type ScheduleProblem = "date" | "past" | "time";
/**
 * A confirmed appointment needs the agreed date and a clock time ("10:30", "3pm"). The date may not be in the past, judged in the
 * business's time zone (UTC if none is set). The customer's own preferred date and time are never changed by this.
 */
export function validateSchedule(f: { date?: string | null; time?: string | null }, o: { timeZone: string | null; now: Date; checkPast?: boolean }):
  { ok: true; date: string; time: string } | { ok: false; problem: ScheduleProblem; message: string } {
  const date = (f.date ?? "").trim();
  const time = (f.time ?? "").trim();
  if (!isoDate.safeParse(date).success) return { ok: false, problem: "date", message: "Pick the date you agreed with the customer." };
  if (o.checkPast !== false && date < todayInZone(o.now, o.timeZone)) return { ok: false, problem: "past", message: "That date has already passed. Pick today or a later date." };
  if (!time || parseClockTime(time) === null) return { ok: false, problem: "time", message: "Enter the time as a clock time, for example 10:30 or 3pm." };
  return { ok: true, date, time };
}
/** The notice code for a schedule problem. */
export const scheduleNotice = (p: ScheduleProblem) => (p === "date" ? "appt_need_date" : p === "past" ? "appt_date_past" : "appt_need_time");

/**
 * A link that opens WhatsApp to chat with this customer, so the owner can talk to them from their own phone (the WhatsApp Business
 * app). Not an API message: no template, no 24-hour rule, no Meta API charge. Null if the number is not usable.
 */
export function whatsappLink(phone: string | null | undefined, text = ""): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text.slice(0, 1500))}` : ""}`;
}

/** The notice code that says what really happened when a customer was told (tickets): sent by WhatsApp, by email, tried but FAILED, or not reachable. */
export const deliveryNotice = (prefix: "appt" | "tkt", channel: "whatsapp" | "email" | "failed" | "none") =>
  `${prefix}_done_${channel === "none" ? "not_sent" : channel}`;
