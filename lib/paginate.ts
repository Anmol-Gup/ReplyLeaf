// Simple in-memory pagination for the dashboard lists, plus a query-string builder that keeps
// the other filters when moving between pages. Pure, so it is unit-tested.

export type Page<T> = { items: T[]; page: number; pages: number; total: number; from: number; to: number };

/** `rawPage` comes from the URL, so anything odd (text, 0, negatives, too big) is clamped. */
export function paginate<T>(all: T[], rawPage: unknown, size: number): Page<T> {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const n = Number.parseInt(String(rawPage ?? "1"), 10);
  const page = Number.isFinite(n) ? Math.min(Math.max(n, 1), pages) : 1;
  const start = (page - 1) * size;
  const items = all.slice(start, start + size);
  return { items, page, pages, total, from: total ? start + 1 : 0, to: start + items.length };
}

/** "?a=1&b=2", leaving out empty values. Returns "" when nothing is left. */
export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
