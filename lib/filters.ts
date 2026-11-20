// Multi-select filters (status dropdowns on Leads, Tickets, Appointments, Human handoff and Contacts). Pure, so unit-tested.
// The choice lives in the URL as repeated parameters (?status=new&status=won), so it survives reloads and pagination.

/** Values from the URL (one string, several, or nothing), kept only if they are in `allowed`, de-duplicated, in `allowed` order. */
export function parseMulti(raw: string | string[] | undefined, allowed: readonly string[]): string[] {
  const given = new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).flatMap((v) => v.split(",")));
  return allowed.filter((a) => given.has(a));
}

/** What the person chose, or the default when they chose nothing. `explicit` is true only for a real choice (kept in links). */
export function effectiveSelection(raw: string | string[] | undefined, allowed: readonly string[], fallback: readonly string[]): { selected: string[]; explicit: boolean } {
  const chosen = parseMulti(raw, allowed);
  return chosen.length ? { selected: chosen, explicit: true } : { selected: [...fallback], explicit: false };
}

/** "All", "New, Won" or "New, Won +2". */
export function selectionSummary(selected: readonly string[], options: { value: string; label: string }[]): string {
  if (selected.length === 0 || selected.length === options.length) return "All";
  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

import { buildQuery } from "./paginate";

/** The address for a list with these statuses chosen. Nothing chosen = no status in the address (the page's default view). */
export function filterHref(action: string, selected: readonly string[], hidden: Record<string, string | undefined> = {}, param = "status"): string {
  return `${action}${buildQuery({ [param]: [...selected], ...hidden })}`;
}
