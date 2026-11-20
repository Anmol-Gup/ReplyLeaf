import Link from "next/link";
import MultiSelectFilter from "../../../components/MultiSelectFilter";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmtDay, matches } from "../../../lib/dashboard";
import { effectiveSelection } from "../../../lib/filters";
import { buildQuery, paginate } from "../../../lib/paginate";
import { PRIORITIES, PRIORITY_LABELS, priorityOf, TICKET_LABELS, TICKET_STATUSES, TICKET_TONES, ticketOverview, ticketRef, type TicketStatus } from "../../../lib/tickets";
import Notice from "../Notice";

type Row = {
  id: string; customer_name: string | null; customer_phone: string; subject: string; category: string | null; priority: string;
  status: TicketStatus; assigned_to: string | null; created_at: string;
};

export default async function Tickets({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string | string[]; priority?: string | string[]; page?: string }> }) {
  const { notice, q, status: statusRaw, priority: priorityRaw, page: pageRaw } = await searchParams;
  // Nothing chosen = every status (the page never starts with a filter you did not pick).
  const { selected: statuses, explicit } = effectiveSelection(statusRaw, TICKET_STATUSES, []);
  const { selected: priorities, explicit: priorityExplicit } = effectiveSelection(priorityRaw, PRIORITIES, []); // nothing chosen = every priority
  const { db } = await requireClient(); // RLS: only this business's rows can come back

  const { data, error } = await db.from("tickets")
    .select("id, customer_name, customer_phone, subject, category, priority, status, assigned_to, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const all = (data ?? []) as Row[];
  const o = ticketOverview(all);
  const options = TICKET_STATUSES.map((s) => ({ value: s as string, label: TICKET_LABELS[s], count: all.filter((r) => r.status === s).length }));

  const priorityOptions = PRIORITIES.map((p) => ({ value: p as string, label: PRIORITY_LABELS[p], count: all.filter((r) => priorityOf(r.priority) === p).length }));

  const matching = all.filter((r) =>
    (statuses.length === 0 || statuses.includes(r.status)) &&
    (priorities.length === 0 || priorities.includes(priorityOf(r.priority))) &&
    matches(q, r.customer_name, r.customer_phone, r.subject, r.category, r.assigned_to, ticketRef(r.id), TICKET_LABELS[r.status]));
  const paged = paginate(matching, pageRaw, 15);

  return (
    <>
      <PageHeader title="Tickets" description="Problems customers raise, such as an order that didn't arrive. The assistant collects the details; you look into it and keep the customer updated." />
      <Notice code={notice} />
      <div className="stat-grid">
        <Stat value={o.open} label="Open" />
        <Stat value={o.inProgress} label="In progress or waiting" />
        <Stat value={o.urgent} label="High priority and open" />
        <Stat value={o.done} label="Resolved or closed" />
      </div>
      <div className="filters">
        <MultiSelectFilter action="/dashboard/tickets" options={options} selected={statuses} hidden={{ q, priority: priorityExplicit ? priorities : [] }} />
        <MultiSelectFilter action="/dashboard/tickets" label="Priority" plural="priorities" param="priority" options={priorityOptions} selected={priorities} hidden={{ q, status: explicit ? statuses : [] }} />
        <SearchBox q={q} placeholder="Search by name, phone, issue, category, reference or assignee" keep={{ status: explicit ? statuses : [], priority: priorityExplicit ? priorities : [] }} />
      </div>
      {error ? <ErrorState>Your tickets could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ref</th><th>Customer</th><th>Issue</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Raised</th><th></th></tr></thead>
            <tbody>
              {paged.items.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/tickets/${r.id}`}>{ticketRef(r.id)}</Link></td>
                  <td>{r.customer_name || "(no name)"}<br /><span className="muted">+{r.customer_phone}</span></td>
                  <td>{clip(r.subject, 70)}{r.category && <><br /><span className="muted">{r.category}</span></>}</td>
                  <td>{priorityOf(r.priority) === "high" ? <Badge tone="danger">High</Badge> : <span className="muted">{PRIORITY_LABELS[priorityOf(r.priority)]}</span>}</td>
                  <td><Badge tone={TICKET_TONES[r.status]}>{TICKET_LABELS[r.status]}</Badge></td>
                  <td>{r.assigned_to ?? "-"}</td>
                  <td>{fmtDay(r.created_at)}</td>
                <td><Link className="btn btn-secondary btn-sm" href={`/dashboard/tickets/${r.id}#edit`}>Edit</Link></td>
                </tr>
              ))}
              {paged.items.length === 0 && (
                <tr><td colSpan={8}>
                  {q || explicit || priorityExplicit
                    ? <EmptyState icon="search" title="No matching tickets" action={{ href: "/dashboard/tickets", label: "Show all tickets" }}>Nothing matches this view.</EmptyState>
                    : <EmptyState icon="shield" title="No tickets yet">When a customer reports a problem, the assistant collects the details and the ticket appears here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Tickets" hrefFor={(n) => `/dashboard/tickets${buildQuery({ status: explicit ? statuses : [], priority: priorityExplicit ? priorities : [], q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
