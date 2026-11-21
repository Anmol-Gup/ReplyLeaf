"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationLink } from "./ConversationsShell";
import Icon from "./Icon";
import type { ConversationItem } from "../lib/conversation-list";
import { CONVERSATION_FILTERS, FILTER_LABELS, STATE_LABELS, type ConversationFilter } from "../lib/conversation-state";
import { ago } from "../lib/notifications";

// Filters across the top, the list on the left, the chat (and its details) on the right. Filters and search go to /api/conversations; the
// list refreshes in place every few seconds without reloading the page or losing the chosen filter. The server's answer is what is shown.
const ZERO: Record<ConversationFilter, number> = { all: 0, ai: 0, waiting: 0, assigned: 0, unread: 0 };

export function Avatar({ name, phone }: { name: string; phone?: boolean }) {
  return <span className="avatar" aria-hidden="true">{phone ? <Icon name="chat" size={16} /> : (name.trim()[0] ?? "?").toUpperCase()}</span>;
}

export default function ConversationsWorkspace({ children }: { children: React.ReactNode }) {
  const detail = usePathname() !== "/dashboard/conversations";
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [counts, setCounts] = useState(ZERO);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch(`/api/conversations?filter=${filter}&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json();
      if (mine !== seq.current) return; // a newer request is in flight: ignore this stale answer
      if (!r.ok || d.error) throw new Error("load");
      setItems(d.items); setCounts(d.counts); setFailed(false);
    } catch { if (mine === seq.current) setFailed(true); }
  }, [filter, q]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className={`conv-toolbar${detail ? " is-detail" : ""}`}>
        <div className="conv-filters" role="group" aria-label="Filter conversations">
          {CONVERSATION_FILTERS.map((f) => (
            <button key={f} type="button" className={`pill${f === filter ? " on" : ""}`} aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {FILTER_LABELS[f]} <span className="pill-count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={`conv${detail ? " is-detail" : ""}`}>
        <aside className="conv-list" aria-label="Conversations">
        <div className="search conv-search conv-search-left">
          <Icon name="search" size={16} />
          <label className="sr-only" htmlFor="conv-search">Search conversations</label>
          <input id="conv-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations..." maxLength={80} />
        </div>
          {failed && <p className="hint conv-note" role="status">Could not refresh. Retrying…</p>}
          {items === null ? <p className="muted conv-note">Loading…</p>
            : items.length === 0 ? <p className="muted conv-note">{q || filter !== "all" ? "No conversations match." : "No conversations yet. They appear here when customers message your WhatsApp number."}</p>
            : (
              <div className="conv-items">
                {items.map((c) => (
                  <ConversationLink key={c.id} id={c.id}>
                    <Avatar name={c.name} phone={c.name.startsWith("+")} />
                    <div className="conv-body">
                      <div className="top">
                        <span className="name">{c.name}</span>
                        <small className="muted">{c.lastAt ? ago(c.lastAt) : ""}</small>
                      </div>
                      <div className="preview">{c.preview}{c.unread && <span className="unread-dot" aria-label="Unread" />}</div>
                      <div className="meta">
                        <span className={`state state-${c.state}`}>{STATE_LABELS[c.state]}</span>
                      </div>
                    </div>
                  </ConversationLink>
                ))}
              </div>
            )}
        </aside>
        <div className="conv-main">{children}</div>
      </div>
    </>
  );
}


