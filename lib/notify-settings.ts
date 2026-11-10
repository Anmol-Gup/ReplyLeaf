import { z } from "zod";
import type { OwnerEvent } from "./email/templates";

// Who gets which business email. Pure (unit-tested); the sending lives in supabase-deps.ts.

export type NotificationSettings = {
  primaryEmail: string | null;
  additionalEmails: string[];
  appointments: boolean;
  leads: boolean;
  handoffs: boolean;
};

export const MAX_ADDITIONAL_EMAILS = 5;
const email = z.string().trim().toLowerCase().email().max(200);

/** Comma, semicolon, space or newline separated addresses -> valid unique ones, plus the ones that were rejected. */
export function parseEmails(raw: unknown, max = MAX_ADDITIONAL_EMAILS): { emails: string[]; invalid: string[]; tooMany: boolean } {
  const emails: string[] = [];
  const invalid: string[] = [];
  if (typeof raw !== "string") return { emails, invalid, tooMany: false };
  for (const part of raw.split(/[,;\s]+/)) {
    if (!part) continue;
    const r = email.safeParse(part);
    if (!r.success) invalid.push(part.slice(0, 60));
    else if (!emails.includes(r.data)) emails.push(r.data);
  }
  return { emails: emails.slice(0, max), invalid, tooMany: emails.length > max };
}

export const parseOneEmail = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const r = email.safeParse(raw);
  return r.success ? r.data : null;
};

export type EventCategory = "appointment" | "lead" | "handoff" | "always";
export function eventCategory(e: OwnerEvent): EventCategory {
  switch (e.type) {
    case "appointment_request": case "appointment_update": return "appointment";
    case "new_lead": case "lead_created": return "lead";
    case "needs_human": return "handoff";
    default: return "always"; // "your number is connected": always sent
  }
}

/** The addresses to email for this kind of event. Empty when that category is switched off or nobody is configured. */
export function recipientsFor(s: NotificationSettings | null, fallbackOwnerEmail: string | null, category: EventCategory): string[] {
  const on = !s || category === "always" || (category === "appointment" ? s.appointments : category === "lead" ? s.leads : s.handoffs);
  if (!on) return [];
  const primary = s?.primaryEmail ?? fallbackOwnerEmail;
  const all = [primary, ...(s?.additionalEmails ?? [])].filter((x): x is string => Boolean(x));
  return [...new Set(all.map((x) => x.toLowerCase()))];
}
