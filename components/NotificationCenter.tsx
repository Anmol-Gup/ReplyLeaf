"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { ago, safeLink, type LiveNotification, type LivePayload } from "../lib/notifications";

// Bell in the top bar: unread count, recent list, mark read, open the record. Desktop alerts and sound are opt-in, per browser.
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

/** Called when new notifications arrive: toast is handled by the shell; this does the optional desktop notification and sound. */
export function alertOutside(fresh: LiveNotification[], prefs: Prefs) {
  if (prefs.sound) beep();
  if (prefs.desktop && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
    for (const n of fresh) {
      const x = new Notification(n.title, { body: n.body ?? undefined, tag: n.id }); // same tag = never doubled
      x.onclick = () => { window.focus(); window.location.href = safeLink(n.link); };
    }
  }
}

export default function NotificationCenter({ data, offline, markRead, prefs, savePrefs }: {
  data: LivePayload; offline: boolean; markRead: (b: { id: string } | { all: true }) => void; prefs: Prefs; savePrefs: (p: Prefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  // Permission is asked only here, after the person turns desktop alerts on, and never again if it was refused.
  const toggleDesktop = async () => {
    if (prefs.desktop) return savePrefs({ ...prefs, desktop: false });
    if (typeof Notification === "undefined") return setNote("This browser does not support desktop alerts.");
    if (Notification.permission === "denied") return setNote("Desktop alerts are blocked in your browser settings for this site.");
    const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (p === "granted") { setNote(""); savePrefs({ ...prefs, desktop: true }); } else setNote("Permission was not given, so desktop alerts stay off.");
  };

  return (
    <div className="bell" ref={box}>
      <button type="button" className="btn btn-secondary btn-sm bell-button" aria-expanded={open} aria-haspopup="true" aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ""}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={16} />{data.unread > 0 && <span className="count" aria-hidden="true">{data.unread > 99 ? "99+" : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="spread bell-head">
            <b>Notifications</b>
            <button type="button" className="btn btn-ghost btn-sm" disabled={data.unread === 0} onClick={() => markRead({ all: true })}>Mark all read</button>
          </div>
          {offline && <p className="hint" role="status">Reconnecting… showing the last update.</p>}
          {data.notifications.length === 0 ? <p className="muted bell-empty">Nothing yet. New customer requests will appear here.</p> : (
            <ul className="bell-list">
              {data.notifications.map((n) => (
                <li key={n.id} className={n.read ? "" : "unread"}>
                  <Link href={safeLink(n.link)} onClick={() => { if (!n.read) markRead({ id: n.id }); setOpen(false); }}>
                    <b>{n.title}</b>
                    {n.body && <span>{n.body}</span>}
                    <small className="muted">{ago(n.created_at)}</small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="bell-prefs">
            <label className="check"><input type="checkbox" checked={prefs.desktop} onChange={toggleDesktop} /> Desktop alerts</label>
            <label className="check"><input type="checkbox" checked={prefs.sound} onChange={(e) => { savePrefs({ ...prefs, sound: e.target.checked }); if (e.target.checked) beep(); }} /> Sound</label>
            {note && <p className="hint">{note}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
