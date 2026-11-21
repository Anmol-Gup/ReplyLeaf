"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pickToasts, type LiveNotification, type LivePayload } from "../lib/notifications";

// Polls /api/live. The database is the source of truth: every poll replaces the state, so a dropped connection or a missed
// poll heals itself on the next one (and when the tab becomes visible or the network returns). No client-side event log.
const EMPTY: LivePayload = { notifications: [], unread: 0, counts: { waiting: 0, mine: 0, unreadChats: 0 } };
const POLL_MS = 8000;
const SEEN_KEY = "replyleaf.notifications.lastSeen";

export function useLive(onNew: (fresh: LiveNotification[]) => void) {
  const [data, setData] = useState<LivePayload>(EMPTY);
  const [offline, setOffline] = useState(false);
  const shown = useRef(new Set<string>());
  const first = useRef(true);
  const cb = useRef(onNew);
  cb.current = onNew;

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/live", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as LivePayload;
      let lastSeen: string | null = null;
      try { lastSeen = localStorage.getItem(SEEN_KEY); } catch { /* storage unavailable */ }
      const fresh = pickToasts(d.notifications, shown.current, lastSeen, first.current);
      for (const n of d.notifications) shown.current.add(n.id); // never toast the same one twice, even if skipped by the cap
      first.current = false;
      try { if (d.notifications[0]) localStorage.setItem(SEEN_KEY, d.notifications[0].created_at); } catch { /* ignore */ }
      setData(d); setOffline(false);
      if (fresh.length) cb.current(fresh);
    } catch { setOffline(true); }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(() => { if (document.visibilityState === "visible") poll(); }, POLL_MS);
    const wake = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); };
  }, [poll]);

  // Optimistic: the badge and list change at once; if the server refuses, they go back and false is returned.
  const markRead = useCallback(async (body: { id: string } | { all: true }, wasUnread = true): Promise<boolean> => {
    let before: LivePayload | null = null;
    setData((d) => { before = d; return { ...d, notifications: d.notifications.map((n) => ("all" in body || n.id === body.id ? { ...n, read: true } : n)), unread: "all" in body ? 0 : Math.max(0, d.unread - (wasUnread ? 1 : 0)) }; });
    try {
      const r = await fetch("/api/live/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      poll();
      return true;
    } catch {
      if (before) setData(before);
      return false;
    }
  }, [poll]);

  return { data, offline, markRead, refresh: poll };
}
