"use client";

import Link from "next/link";
import { useState } from "react";
import Icon, { type IconName } from "./Icon";
import { Badge } from "./ui";

// A customer's activity: filter by kind, the latest five, then five more at a time. Items arrive ready to show (no data access here).
export type ActivityItem = { key: string; kind: "lead" | "appointment" | "ticket" | "handoff"; title: string; detail: string; href: string; at: string; label: string; tone: "brand" | "success" | "warn" | "danger" | "muted" };
const KINDS: { id: "all" | ActivityItem["kind"]; label: string }[] = [
  { id: "all", label: "All" }, { id: "handoff", label: "Handoffs" }, { id: "lead", label: "Leads" }, { id: "appointment", label: "Appointments" }, { id: "ticket", label: "Tickets" },
];
const ICON: Record<ActivityItem["kind"], IconName> = { handoff: "shield", lead: "zap", appointment: "calendar", ticket: "alert" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }); // the viewer's own time zone
const month = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const STEP = 5;

export default function ActivityList({ items }: { items: ActivityItem[] }) {
  const [kind, setKind] = useState<"all" | ActivityItem["kind"]>("all");
  const [shown, setShown] = useState(STEP);
  const counts = (k: string) => (k === "all" ? items.length : items.filter((i) => i.kind === k).length);
  const list = items.filter((i) => kind === "all" || i.kind === kind);
  const visible = list.slice(0, shown);
  const hidden = Math.max(0, list.length - shown);
  let lastMonth = "";
  return (
    <>
      <div className="conv-filters rec-filters" role="group" aria-label="Filter activity">
        {KINDS.filter((k) => k.id === "all" || counts(k.id) > 0).map((k) => (
          <button key={k.id} type="button" className={`pill${k.id === kind ? " on" : ""}`} aria-pressed={k.id === kind} onClick={() => { setKind(k.id); setShown(STEP); }}>
            {k.label} <span className="pill-count">{counts(k.id)}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? <p className="muted">Nothing yet: no enquiries, appointments, tickets or handoffs.</p> : (
        <div className="rec-activity">
          {visible.map((t) => {
            const m = month(t.at);
            const head = m !== lastMonth ? <h3 className="rec-month">{m}</h3> : null;
            lastMonth = m;
            return (
              <div key={t.key}>
                {head}
                <article className="rec-item">
                  <span className={`rec-ico rec-${t.kind}`}><Icon name={ICON[t.kind]} size={16} /></span>
                  <div className="rec-main">
                    <div className="rec-top"><b><Link href={t.href}>{t.title}</Link></b><span className="muted">{day(t.at)}</span></div>
                    {t.detail && <p>{t.detail}</p>}
                    <Badge tone={t.tone}>{t.label}</Badge>
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
