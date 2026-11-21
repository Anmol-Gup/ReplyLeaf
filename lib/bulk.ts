// The ids ticked in a list for a bulk action: only well-formed ids, no repeats, at most 200 at a time.
export const MAX_BULK = 200;
export function parseIds(raw: unknown[]): string[] {
  const ok = raw.filter((v): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  return [...new Set(ok)].slice(0, MAX_BULK);
}
