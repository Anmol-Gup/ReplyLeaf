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
