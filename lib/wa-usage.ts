// WhatsApp messaging usage for the Usage page and the admin page. Pure (unit-tested).
//
// Meta gives each ELIGIBLE business phone number its first 1,000 delivered SERVICE messages a month free (from 1 October 2026); more
// are charged. Replyleaf does not know every account's eligibility, so it is a setting (eligible / not_eligible / unknown) and
// "unknown" is shown as such. What is shown is an ESTIMATE from the messages Replyleaf sent that WhatsApp reported as delivered;
// Meta's own billing is the source of truth (Replyleaf does not read it). Customer messages never count, messages typed in the
// WhatsApp Business app are not sent through Replyleaf so they are not counted, and failed, blocked or not-yet-delivered messages
// are never counted as delivered. No prices are stored anywhere: they vary by country and category and change.

export const FREE_SERVICE_MESSAGES = 1000;

export function serviceUsage(delivered: number): { delivered: number; freeUsed: number; freeRemaining: number; paid: number } {
  const d = Math.max(0, Math.floor(delivered));
  const freeUsed = Math.min(d, FREE_SERVICE_MESSAGES);
  return { delivered: d, freeUsed, freeRemaining: FREE_SERVICE_MESSAGES - freeUsed, paid: d - freeUsed };
}

/** Minutes the zone is ahead of UTC at this instant (a zone ahead of UTC gives a positive number). */
function offsetMinutes(at: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/** The instant (UTC) when the calendar day y-m-d starts in the zone. */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  return guess - offsetMinutes(first, timeZone) * 60_000; // second pass settles daylight-saving changes
}

/** The current month in the business's time zone (UTC when none is set): when it started and when the next one starts. */
export function monthBounds(now: Date, timeZone: string | null): { start: Date; next: Date } {
  let zone = timeZone;
  if (zone) { try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { zone = null; } }
  if (!zone) return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric" }).formatToParts(now).map((x) => [x.type, Number(x.value)]));
  const ny = p.month === 12 ? p.year + 1 : p.year;
  const nm = p.month === 12 ? 1 : p.month + 1;
  return { start: new Date(zonedMidnight(p.year, p.month, 1, zone)), next: new Date(zonedMidnight(ny, nm, 1, zone)) };
}

export type Eligibility = "eligible" | "not_eligible" | "unknown";
export const ELIGIBILITY_LABELS: Record<Eligibility, string> = {
  eligible: "Eligible for the free allowance",
  not_eligible: "Not eligible for the free allowance",
  unknown: "Eligibility not confirmed",
};
export const isEligibility = (v: unknown): v is Eligibility => v === "eligible" || v === "not_eligible" || v === "unknown";

/** One row of wa_usage_summary(): a phone number and message category. */
export type UsageRow = { out_phone_number_id: string | null; out_category: string; out_total: number | string; out_delivered: number | string; out_failed: number | string; out_awaiting: number | string };

export type PhoneUsage = {
  phoneNumberId: string | null;
  eligibility: Eligibility;
  totalOutgoing: number;
  deliveredService: number;
  freeAllowance: number;           // 1,000 when the allowance may apply, 0 when the number is known not to be eligible
  freeUsed: number;
  freeRemaining: number;           // max(0, 1000 - delivered service messages)
  chargeableService: number;       // max(0, delivered service messages - 1000)
  marketing: number; utility: number; authentication: number; unclassified: number;
  failed: number;
  awaiting: number;                // accepted by WhatsApp, no delivery update yet: not counted as delivered
  percentUsed: number;             // of the free allowance, 0-100
  state: "ok" | "near" | "exhausted" | "not_applicable";
};

const num = (v: number | string) => Number(v) || 0;

/** Usage per business phone number (numbers never mix). `eligibility` is the business's setting. */
export function summariseUsage(rows: UsageRow[], eligibility: Eligibility): PhoneUsage[] {
  const byPhone = new Map<string, UsageRow[]>();
  for (const r of rows) byPhone.set(r.out_phone_number_id ?? "", [...(byPhone.get(r.out_phone_number_id ?? "") ?? []), r]);
  return [...byPhone.entries()].map(([phone, rs]) => {
    const sum = (category: string, field: "out_delivered" | "out_total" = "out_delivered") => rs.filter((r) => r.out_category === category).reduce((n, r) => n + num(r[field]), 0);
    const deliveredService = sum("service");
    const freeAllowance = eligibility === "not_eligible" ? 0 : FREE_SERVICE_MESSAGES;
    const freeUsed = Math.min(deliveredService, freeAllowance);
    const percentUsed = freeAllowance ? Math.min(100, Math.round((deliveredService / freeAllowance) * 100)) : 0;
    return {
      phoneNumberId: phone || null,
      eligibility,
      totalOutgoing: rs.reduce((n, r) => n + num(r.out_total), 0),
      deliveredService,
      freeAllowance,
      freeUsed,
      freeRemaining: Math.max(0, freeAllowance - deliveredService),
      chargeableService: Math.max(0, deliveredService - freeAllowance),
      marketing: sum("marketing"), utility: sum("utility"), authentication: sum("authentication"), unclassified: sum("unknown"),
      failed: rs.reduce((n, r) => n + num(r.out_failed), 0),
      awaiting: rs.reduce((n, r) => n + num(r.out_awaiting), 0),
      percentUsed,
      state: freeAllowance === 0 ? "not_applicable" : deliveredService >= freeAllowance ? "exhausted" : percentUsed >= 80 ? "near" : "ok",
    };
  });
}

/** What the customer's own Meta billing status is: Replyleaf cannot see it, and says so rather than guessing. */
export const BILLING_STATUS_UNAVAILABLE = "Billing status unavailable";
/** WhatsApp Manager, where the account's payment method and billing live. */
export const WHATSAPP_MANAGER_URL = "https://business.facebook.com/wa/manage/home/";

/** How a message's category is decided: from how it was SENT, never from its text. A template carries its own category. */
export function messageCategory(m: { type: string; templateCategory?: string | null }): "service" | "marketing" | "utility" | "authentication" | "unknown" {
  if (m.type === "template") {
    const c = m.templateCategory?.toLowerCase();
    return c === "marketing" || c === "utility" || c === "authentication" ? c : "unknown";
  }
  return "service"; // free-form messages (text, media, interactive) sent inside the customer service window
}

/**
 * Eligibility, worked out from what Meta itself reported on delivered messages instead of asking the owner:
 * a message marked free_tier means the number gets the allowance; a charged service message with no free_tier ever seen means it does not.
 * With no signal yet it falls back to the stored value (unknown for new accounts).
 */
export function detectEligibility(c: { wa_free_tier_seen_at?: string | null; wa_paid_service_seen_at?: string | null; wa_free_allowance?: unknown }): Eligibility {
  if (c.wa_free_tier_seen_at) return "eligible";
  if (c.wa_paid_service_seen_at) return "not_eligible";
  return isEligibility(c.wa_free_allowance) ? c.wa_free_allowance : "unknown";
}
