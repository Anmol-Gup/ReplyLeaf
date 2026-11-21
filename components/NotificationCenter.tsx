"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";
import {
  ago, badgeText, DRAWER_FILTER_LABELS, DRAWER_FILTERS, groupByDay, matchesDrawerFilter, mergeItems, safeLink,
  type DrawerCounts, type DrawerFilter, type LiveNotification, type LivePayload,
} from "../lib/notifications";

// Bell in the top bar and a right-side drawer: filters with counts, grouped by day, 20 at a time. The server (/api/notifications) is the
// source of truth; the 8-second /api/live poll that already feeds the bell is also merged in, so new items appear without a second poll.
// Desktop alerts and sound are opt-in, per browser, and the browser permission is asked only when "Desktop alerts" is ticked.
const PREF = "replyleaf.notifications.prefs";
type Prefs = { desktop: boolean; sound: boolean };
const readPrefs = (): Prefs => { try { return { desktop: false, sound: false, ...JSON.parse(localStorage.getItem(PREF) ?? "{}") }; } catch { return { desktop: false, sound: false }; } };

export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = new Ctx(); const o = c.createOscillator(); const g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.05; o.start(); o.stop(c.currentTime + 0.18);
  } catch { /* sound is optional */ }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>({ desktop: false, sound: false });
  useEffect(() => setPrefs(readPrefs()), []);
  const save = (p: Prefs) => { setPrefs(p); try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* ignore */ } };
  return { prefs, save };
}

/** Called when new notifications arrive: the optional sound and the optional desktop notification (only while the tab is in the background). */
export function alertOutside(fresh: LiveNotification[], prefs: Prefs) {
  if (prefs.sound) beep();
  if (prefs.desktop && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
    for (const n of fresh) {
      const x = new Notification(n.title, { body: n.body ?? undefined, tag: n.id }); // same tag = never doubled
      x.onclick = () => { window.focus(); window.location.href = safeLink(n.link); };
    }
  }
}

const ICONS: Record<string, IconName> = { handoff: "shield", message: "chat", appointment: "calendar", ticket: "alert" };
const ZERO: DrawerCounts = { all: 0, unread: 0, handoff: 0, appointment: 0, ticket: 0 };
const EMPTY_TEXT: Record<DrawerFilter, [string, string]> = {
  all: ["No notifications", "Nothing yet. New customer activity will appear here."],
  unread: ["No unread notifications", "You're all caught up."],
  handoff: ["No notifications for this filter", "No notifications in this category yet."],
  appointment: ["No notifications for this filter", "No notifications in this category yet."],
  ticket: ["No notifications for this filter", "No notifications in this category yet."],
};

export default function NotificationCenter({ data, offline, markRead, prefs, savePrefs }: {
  data: LivePayload; offline: boolean; markRead: (b: { id: string } | { all: true }, wasUnread?: boolean) => Promise<boolean>; prefs: Prefs; savePrefs: (p: Prefs) => void;
}) {
  const [mounted, setMounted] = useState(false); // in the page (needed for the slide-out)
  const [shown, setShown] = useState(false);     // slid in
  const [filter, setFilter] = useState<DrawerFilter>("all");
  const [items, setItems] = useState<LiveNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<DrawerCounts>(ZERO);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const panel = useRef<HTMLElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  // First page (or the first page again after a filter change). Stale answers are ignored.
  const loadFirst = useCallback(async (f: DrawerFilter) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/notifications?filter=${f}`, { cache: "no-store" });
      const d = await r.json();
      if (mine !== seq.current) return;
      if (!r.ok || d.error) throw new Error("load");
      setItems(d.items); setCursor(d.nextCursor); setCounts(d.counts ?? ZERO); setFailed(false);
    } catch { if (mine === seq.current) setFailed(true); } finally { if (mine === seq.current) setLoading(false); }
  }, []);

  const loadMore = async () => {
    if (!cursor || loading) return;
    const mine = seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/notifications?filter=${filter}&cursor=${encodeURIComponent(cursor)}&counts=0`, { cache: "no-store" });
      const d = await r.json();
      if (mine !== seq.current) return;
      if (!r.ok || d.error) throw new Error("load");
      setItems((cur) => mergeItems(cur, d.items)); setCursor(d.nextCursor); setFailed(false);
    } catch { setFailed(true); } finally { setLoading(false); }
  };

  const openDrawer = () => { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setShown(true))); };
  const closeDrawer = useCallback(() => { setShown(false); setTimeout(() => { setMounted(false); bell.current?.focus(); }, 220); }, []);

  useEffect(() => { if (mounted && shown) loadFirst(filter); }, [mounted, shown, filter, loadFirst]);

  // Real time: whenever the live poll brings something new (or the unread number moves) while the drawer is open, merge it in.
  const newest = data.notifications[0]?.id ?? "";
  useEffect(() => {
    if (!shown) return;
    setItems((cur) => {
      const fresh = data.notifications.filter((n) => matchesDrawerFilter(filter, n) || cur.some((c) => c.id === n.id));
      const updated = cur.map((c) => data.notifications.find((n) => n.id === c.id) ?? c); // read state follows the server
      return mergeItems(updated, fresh).filter((n) => filter !== "unread" || !n.read || cur.some((c) => c.id === n.id));
    });
    (async () => { try { const r = await fetch(`/api/notifications?filter=${filter}&counts=1`, { cache: "no-store" }); const d = await r.json(); if (r.ok && d.counts) setCounts(d.counts); } catch { /* the next poll tries again */ } })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest, data.unread, shown]);

  // Escape closes; Tab stays inside; the page behind does not scroll.
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return closeDrawer();
      if (e.key !== "Tab" || !panel.current) return;
      const f = panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-close]")?.focus(), 50);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", key); clearTimeout(t); };
  }, [mounted, closeDrawer]);

  const read = async (n: LiveNotification) => {
    if (n.read) return;
    setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    setCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }));
    if (!(await markRead({ id: n.id }, true))) { // the server refused: put it back
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: false } : x)));
      setCounts((c) => ({ ...c, unread: c.unread + 1 }));
      setNote("Could not mark that as read. Please try again.");
    }
  };
  const readAll = async () => {
    const snapshot = items, snapCounts = counts;
    setItems((cur) => cur.map((x) => ({ ...x, read: true }))); setCounts((c) => ({ ...c, unread: 0 }));
    if (!(await markRead({ all: true }, true))) { setItems(snapshot); setCounts(snapCounts); setNote("Could not mark all as read. Please try again."); }
  };

  // Permission is asked only here, after the person turns desktop alerts on, and never again if it was refused.
  const toggleDesktop = async () => {
    if (prefs.desktop) return savePrefs({ ...prefs, desktop: false });
    if (typeof Notification === "undefined") return setNote("This browser does not support desktop alerts.");
    if (Notification.permission === "denied") return setNote("Desktop alerts are blocked in your browser settings for this site.");
    const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (p === "granted") { setNote(""); savePrefs({ ...prefs, desktop: true }); } else setNote("Permission was not given, so desktop alerts stay off.");
  };

  const groups = groupByDay(items);
  const [emptyTitle, emptyText] = EMPTY_TEXT[filter];

  return (
    <>
      <button ref={bell} type="button" className="btn btn-secondary btn-sm bell-button" aria-haspopup="dialog" aria-expanded={mounted}
        aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ""}`} onClick={openDrawer}>
        <Icon name="bell" size={16} />{data.unread > 0 && <span className="count" aria-hidden="true">{badgeText(data.unread)}</span>}
      </button>
      {mounted && (
        <div className={`drawer-root${shown ? " shown" : ""}`}>
          <div className="drawer-overlay" onClick={closeDrawer} aria-hidden="true" />
          <aside ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <header className="drawer-head">
              <div>
                <h2 id="drawer-title">Notifications</h2>
                <p className="muted">{counts.unread} unread</p>
              </div>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={counts.unread === 0} onClick={readAll}>Mark all as read</button>
                <button type="button" data-close className="btn btn-ghost btn-sm" aria-label="Close notifications" onClick={closeDrawer}><Icon name="x" size={18} /></button>
              </div>
            </header>
            <div className={`drawer-filters${loading ? " is-loading" : ""}`} role="group" aria-label="Filter notifications" aria-busy={loading}>
              {DRAWER_FILTERS.map((f) => (
                <button key={f} type="button" className={`pill${f === filter ? " on" : ""}`} aria-pressed={f === filter} onClick={() => setFilter(f)}>
                  {DRAWER_FILTER_LABELS[f]} <span className="pill-count">{counts[f]}</span>
                </button>
              ))}
            </div>
            <div className={`drawer-body${loading ? " is-loading" : ""}`} aria-busy={loading}>
              {(offline || failed) && <p className="hint drawer-note" role="status">{failed ? "Could not load notifications." : "Reconnecting… showing the last update."} <button type="button" className="link-button" onClick={() => loadFirst(filter)}>Try again</button></p>}
              {note && <p className="hint drawer-note" role="alert">{note}</p>}
              {items.length === 0 && !loading && !failed ? (
                <div className="drawer-empty"><span className="stat-icon"><Icon name="bell" /></span><b>{emptyTitle}</b><span className="muted">{emptyText}</span></div>
              ) : (
                <>
                  {groups.map((g) => (
                    <section key={g.label} aria-label={g.label}>
                      <h3 className="drawer-group">{g.label} ({g.items.length})</h3>
                      <ul className="drawer-list">
                        {g.items.map((n) => (
                          <li key={n.id} className={n.read ? "" : "unread"}>
                            <Link href={safeLink(n.link)} onClick={() => { read(n); closeDrawer(); }}>
                              <span className={`n-icon n-${n.kind}`}><Icon name={ICONS[n.kind] ?? "info"} size={16} /></span>
                              <span className="n-text">
                                <b>{n.title}{!n.read && <span className="sr-only"> (unread)</span>}</b>
                                {n.body && <span>{n.body}</span>}
                                <small className="muted">{ago(n.created_at)}</small>
                              </span>
                              {!n.read && <span className="n-dot" aria-hidden="true" />}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  {loading && <div className="drawer-loading" role="status" aria-label="Loading notifications"><span className="spinner" aria-hidden="true" /></div>}
                  {!loading && cursor && <div className="drawer-more"><button type="button" className="btn btn-secondary btn-sm" onClick={loadMore}>Load more</button></div>}
                  {!loading && !cursor && items.length > 0 && <p className="muted drawer-note">You&apos;ve reached the end.</p>}
                </>
              )}
            </div>
            <footer className="drawer-foot">
              <label className="check"><input type="checkbox" checked={prefs.desktop} onChange={toggleDesktop} /> Desktop alerts</label>
              <label className="check"><input type="checkbox" checked={prefs.sound} onChange={(e) => { savePrefs({ ...prefs, sound: e.target.checked }); if (e.target.checked) beep(); }} /> Sound alerts</label>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
