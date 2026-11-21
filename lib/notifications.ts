// Pure helpers for the live notification poll (unit-tested).
export type LiveNotification = { id: string; kind: string; title: string; body: string | null; link: string | null; read: boolean; created_at: string };
export type LiveCounts = { waiting: number; mine: number; unreadChats: number };
export type LivePayload = { notifications: LiveNotification[]; unread: number; counts: LiveCounts };

export const MAX_TOASTS = 3;

/**
 * Which notifications should pop up now. Only unread ones not shown before, and (on the first poll of a page) only those newer than
 * the last time this browser looked, so a reload never replays old alerts yet nothing missed while offline is lost.
 * The database stays the source of truth: anything not toasted is still in the bell.
 */
export function pickToasts(list: LiveNotification[], shown: Set<string>, lastSeenAt: string | null, first: boolean): LiveNotification[] {
  return list
    .filter((n) => !n.read && !shown.has(n.id) && (!first || !lastSeenAt || n.created_at > lastSeenAt))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-MAX_TOASTS);
}

/** Links must stay inside the dashboard: a notification can never send someone elsewhere. */
export const safeLink = (l: string | null | undefined): string => (l && /^\/dashboard(\/|$|\?)/.test(l) ? l : "/dashboard");

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** A team member shown by name: an email address is shortened to the part before the @. */
export const shortName = (label: string | null | undefined): string => (label ? (label.includes("@") ? label.split("@")[0] : label) : "");

/** Recent times as "5 min ago", older ones as a date. */
export const whenText = (iso: string | null | undefined, now = Date.now()): string =>
  !iso ? "-" : now - new Date(iso).getTime() < 7 * 86400000 ? ago(iso, now) : iso.slice(0, 10);

// ---- the drawer
export const DRAWER_FILTERS = ["all", "unread", "handoff", "appointment", "ticket"] as const;
export type DrawerFilter = (typeof DRAWER_FILTERS)[number];
export const DRAWER_FILTER_LABELS: Record<DrawerFilter, string> = { all: "All", unread: "Unread", handoff: "Human handoff", appointment: "Appointments", ticket: "Tickets" };
/** Which stored kinds each category covers. "message" (a new customer message in a chat you are handling) belongs with human handoff. */
export const FILTER_KINDS: Record<Exclude<DrawerFilter, "all" | "unread">, string[]> = { handoff: ["handoff", "message"], appointment: ["appointment"], ticket: ["ticket"] };
export type DrawerCounts = Record<DrawerFilter, number>;
export const PAGE_SIZE = 20;

/** The bell badge: exact up to 9, then "9+" (and "99+" above 99). */
export const badgeText = (n: number): string => (n > 99 ? "99+" : n > 9 ? "9+" : String(n));

/** A cursor is the last item's time and id, so a page never repeats or skips rows even when several share a time. */
export const encodeCursor = (createdAt: string, id: string) => `${createdAt}|${id}`;
export function decodeCursor(c: string | null): { at: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf("|");
  const at = c.slice(0, i), id = c.slice(i + 1);
  return i > 0 && /^\d{4}-\d{2}-\d{2}T[\d:.+\-Z]+$/.test(at) && /^[0-9a-f-]{36}$/i.test(id) ? { at, id } : null;
}

/** Adds items to a list: no duplicates (a newer copy of the same id wins), newest first. */
export function mergeItems(current: LiveNotification[], incoming: LiveNotification[]): LiveNotification[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export const matchesDrawerFilter = (f: DrawerFilter, n: LiveNotification): boolean =>
  f === "all" ? true : f === "unread" ? !n.read : FILTER_KINDS[f].includes(n.kind);

/** Today / Yesterday / Earlier in the viewer's own time zone. */
export function groupByDay(items: LiveNotification[], now: Date = new Date()): { label: "Today" | "Yesterday" | "Earlier"; items: LiveNotification[] }[] {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(now), yesterday = today - 86400000;
  const groups: Record<"Today" | "Yesterday" | "Earlier", LiveNotification[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const n of items) {
    const d = day(new Date(n.created_at));
    groups[d >= today ? "Today" : d === yesterday ? "Yesterday" : "Earlier"].push(n);
  }
  return (["Today", "Yesterday", "Earlier"] as const).filter((l) => groups[l].length).map((label) => ({ label, items: groups[label] }));
}
