"use client";

import Link from "next/link";
import { useState } from "react";
import Icon, { type IconName } from "./Icon";
import SubmitButton from "./SubmitButton";
import { Badge } from "./ui";

// A record's activity feed, like HubSpot's Activities tab: tabs for All activities and each kind (Notes included), a search box, month groups,
// "Expand all", the latest five then five more, and a note composer. Notes live in the feed, so they are filtered and searched with the rest.
// Items arrive ready to show (no data access here); adding a note goes through the server action given.
export type ActivityItem = {
  key: string; kind: string; icon: IconName; title: string; detail: string; at: string; // at "" = older than dated notes
  href?: string; label?: string; tone?: "brand" | "success" | "warn" | "danger" | "muted"; meta?: string;
};
export type ActivityKind = { id: string; label: string };

const STEP = 5;
const dayOf = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Earlier"); // the viewer's own time zone
const monthOf = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Earlier");

export default function ActivityList({ items, kinds, noteAction, recordId, empty }: {
  items: ActivityItem[]; kinds: ActivityKind[]; noteAction?: (formData: FormData) => void | Promise<void>; recordId?: string; empty?: string;
}) {
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(STEP);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const count = (k: string) => (k === "all" ? items.length : items.filter((i) => i.kind === k).length);
  const needle = q.trim().toLowerCase();
  const list = items.filter((i) => (kind === "all" || i.kind === kind) && (!needle || `${i.title} ${i.detail} ${i.meta ?? ""} ${i.label ?? ""}`.toLowerCase().includes(needle)));
  const visible = list.slice(0, shown);
  const hidden = Math.max(0, list.length - shown);
  let lastMonth = "";
  const tabs = [{ id: "all", label: "All activities" }, ...kinds.filter((k) => k.id === "note" || count(k.id) > 0)];
  return (
    <>
      <div className="act-tabs" role="tablist" aria-label="Activity types">
        {tabs.map((k) => (
          <button key={k.id} type="button" role="tab" aria-selected={k.id === kind} className="act-tab" onClick={() => { setKind(k.id); setShown(STEP); }}>
            {k.label} <span className="pill-count">{count(k.id)}</span>
          </button>
        ))}
      </div>
      <div className="act-tools">
        <div className="search act-search">
          <Icon name="search" size={16} />
          <label className="sr-only" htmlFor="act-q">Search activities</label>
          <input id="act-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); setShown(STEP); }} placeholder="Search activities" />
        </div>
        <div className="row">
          {noteAction && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={composing} onClick={() => setComposing((c) => !c)}>+ Note</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded((e) => !e)}>{expanded ? "Collapse all" : "Expand all"}</button>
        </div>
      </div>
      {composing && noteAction && recordId && (
        <form action={noteAction} className="act-compose stack-sm">
          <input type="hidden" name="id" value={recordId} />
          <label className="sr-only" htmlFor="act-note">Note</label>
          <textarea id="act-note" name="body" required rows={3} maxLength={4000} placeholder="Add a note. Private: only your team sees it, never the customer or the assistant." autoFocus />
          <div className="row"><SubmitButton small pendingText="Saving...">Save note</SubmitButton><button type="button" className="btn btn-ghost btn-sm" onClick={() => setComposing(false)}>Cancel</button></div>
        </form>
      )}
      {visible.length === 0 ? <p className="muted">{needle || kind !== "all" ? "Nothing matches." : empty ?? "Nothing yet."}</p> : (
        <div className="rec-activity">
          {visible.map((t) => {
            const m = monthOf(t.at);
            const head = m !== lastMonth ? <h3 className="rec-month">{m}</h3> : null;
            lastMonth = m;
            return (
              <div key={t.key}>
                {head}
                <article className="rec-item">
                  <span className={`rec-ico rec-${t.kind}`}><Icon name={t.icon} size={16} /></span>
                  <div className="rec-main">
                    <div className="rec-top"><b>{t.href ? <Link href={t.href}>{t.title}</Link> : t.title}</b><span className="muted">{dayOf(t.at)}</span></div>
                    {t.detail && <p className={`rec-detail${expanded ? "" : " clamp"}`}>{t.detail}</p>}
                    {t.meta && <p className="rec-meta">{t.meta}</p>}
                    {t.label && <Badge tone={t.tone ?? "muted"}>{t.label}</Badge>}
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      )}
      {list.length > STEP && (
        <div className="show-more">
          {hidden > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown((s) => s + STEP)}>Show {Math.min(STEP, hidden)} more <span className="muted">({hidden} left)</span></button>}
          {shown > STEP && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(STEP)}>Show less</button>}
        </div>
      )}
    </>
  );
}
