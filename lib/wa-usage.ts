// WhatsApp messaging usage for the Usage page. Pure (unit-tested).
//
// Meta gives each business phone number its first 1,000 delivered SERVICE messages a month free (from 1 October 2026); more are
// charged. It resets monthly, in the business's time zone. What Replyleaf shows is an ESTIMATE from the messages it sent that
// WhatsApp reported as delivered; Meta's own billing is the source of truth. Customer messages never count, and messages the owner
// sends from the WhatsApp Business app on their phone are not sent through Replyleaf, so they are not counted here.

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
