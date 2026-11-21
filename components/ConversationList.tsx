"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationLink } from "./ConversationsShell";
import { Badge } from "./ui";
import type { ConversationItem } from "../lib/conversation-list";
import { CONVERSATION_FILTERS, FILTER_LABELS, STATE_LABELS, STATE_TONES, type ConversationFilter } from "../lib/conversation-state";
import { fmtDay, fmtTime } from "../lib/dashboard";

// The left pane. Filters and search are sent to /api/conversations; the list refreshes in place every few seconds, so it never reloads the page
// or loses the chosen filter. Whatever the server says is shown: there is no local copy of the truth.
export default function ConversationList() {
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch(`/api/conversations?filter=${filter}&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json();
      if (mine !== seq.current) return; // a newer request is in flight: ignore this stale answer
      if (!r.ok || d.error) throw new Error("load");
      setItems(d.items); setFailed(false);
    } catch { if (mine === seq.current) setFailed(true); }
  }, [filter, q]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <aside className="conv-list" aria-label="Conversations">
      <h2>Conversations</h2>
      <div className="conv-tools">
        <label className="sr-only" htmlFor="conv-search">Search conversations</label>
        <input id="conv-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number or message" maxLength={80} />
        <div className="conv-filters" role="group" aria-label="Filter conversations">
          {CONVERSATION_FILTERS.map((f) => (
            <button key={f} type="button" className={`pill${f === filter ? " on" : ""}`} aria-pressed={f === filter} onClick={() => setFilter(f)}>{FILTER_LABELS[f]}</button>
          ))}
        </div>
      </div>
      {failed && <p className="hint conv-note" role="status">Could not refresh. Retrying…</p>}
      {items === null ? <p className="muted conv-note">Loading…</p>
        : items.length === 0 ? <p className="muted conv-note">{q || filter !== "all" ? "No conversations match." : "No conversations yet. They appear here when customers message your WhatsApp number."}</p>
        : (
          <div className="conv-items">
            {items.map((c) => (
              <ConversationLink key={c.id} id={c.id}>
                <div className="top">
                  <span className="name">{c.unread && <span className="unread-dot" aria-label="Unread" />}{c.name}</span>
                  <small className="muted">{c.lastAt ? `${fmtDay(c.lastAt)} ${fmtTime(c.lastAt)}` : ""}</small>
                </div>
                <div className="preview">{c.preview}</div>
                <div className="meta">
                  <Badge tone={STATE_TONES[c.state]}>{STATE_LABELS[c.state]}</Badge>
                  {!c.windowOpen && <Badge>Window closed</Badge>}
                </div>
              </ConversationLink>
            ))}
          </div>
        )}
    </aside>
  );
}
