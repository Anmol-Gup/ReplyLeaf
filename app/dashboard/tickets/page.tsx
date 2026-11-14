import Link from "next/link";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmtDay, matches } from "../../../lib/dashboard";
import { buildQuery, paginate } from "../../../lib/paginate";
import { isOpenTicket, TICKET_LABELS, TICKET_STATUSES, TICKET_TONES, ticketOverview, ticketRef, type TicketStatus } from "../../../lib/tickets";
import Notice from "../Notice";

type Row = {
  id: string; customer_name: string | null; customer_phone: string; subject: string; category: string | null; priority: string;
  status: TicketStatus; assigned_to: string | null; created_at: string;
};

export default async function Tickets({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string; page?: string }> }) {
  const { notice, q, status: statusRaw, page: pageRaw } = await searchParams;
  const status = statusRaw === "all" || (TICKET_STATUSES as readonly string[]).includes(statusRaw ?? "") ? (statusRaw as string) : "open_all";
  const { db } = await requireClient(); // RLS: only this business's rows can come back

  const { data, error } = await db.from("tickets")
    .select("id, customer_name, customer_phone, subject, category, priority, status, assigned_to, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const all = (data ?? []) as Row[];
  const o = ticketOverview(all);
  const count = (k: string) => k === "all" ? all.length : k === "open_all" ? all.filter((r) => isOpenTicket(r.status)).length : all.filter((r) => r.status === k).length;

  const matching = all.filter((r) =>
    (status === "all" || (status === "open_all" ? isOpenTicket(r.status) : r.status === status)) &&
    matches(q, r.customer_name, r.customer_phone, r.subject, r.category, r.assigned_to, ticketRef(r.id), TICKET_LABELS[r.status]));
  const paged = paginate(matching, pageRaw, 15);
  const tabs = [{ key: "open_all", label: "All open" }, ...TICKET_STATUSES.map((s) => ({ key: s as string, label: TICKET_LABELS[s] })), { key: "all", label: "Everything" }];

  return (
    <>
      <PageHeader title="Support tickets" description="Problems customers raise, such as an order that didn't arrive. The assistant collects the details; you look into it and keep the customer updated." />
      <Notice code={notice} />
      <div className="stat-grid">
        <Stat value={o.open} label="Open" />
        <Stat value={o.inProgress} label="In progress or waiting" />
        <Stat value={o.urgent} label="Urgent and open" />
        <Stat value={o.done} label="Resolved or closed" />
      </div>
      <nav className="tabs" aria-label="Filter by status">
        {tabs.map((t) => (
          <Link key={t.key} href={`/dashboard/tickets${buildQuery({ status: t.key === "open_all" ? null : t.key, q })}`}
            className={`tab${status === t.key ? " active" : ""}`} aria-current={status === t.key ? "page" : undefined}>
            {t.label} <span className="tab-count">{count(t.key)}</span>
          </Link>
        ))}
      </nav>
      <SearchBox q={q} placeholder="Search by name, phone, issue, category, reference or assignee" />
      {error ? <ErrorState>Your tickets could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ref</th><th>Customer</th><th>Issue</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Raised</th></tr></thead>
            <tbody>
              {paged.items.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/tickets/${r.id}`}>{ticketRef(r.id)}</Link></td>
                  <td>{r.customer_name || "(no name)"}<br /><span className="muted">+{r.customer_phone}</span></td>
                  <td>{clip(r.subject, 70)}{r.category && <><br /><span className="muted">{r.category}</span></>}</td>
                  <td>{r.priority === "high" ? <Badge tone="danger">Urgent</Badge> : <span className="muted">Normal</span>}</td>
                  <td><Badge tone={TICKET_TONES[r.status]}>{TICKET_LABELS[r.status]}</Badge></td>
                  <td>{r.assigned_to ?? "-"}</td>
                  <td>{fmtDay(r.created_at)}</td>
                </tr>
              ))}
              {paged.items.length === 0 && (
                <tr><td colSpan={7}>
                  {q || status !== "open_all"
                    ? <EmptyState icon="search" title="No matching tickets" action={{ href: "/dashboard/tickets", label: "Show open tickets" }}>Nothing matches this view.</EmptyState>
                    : <EmptyState icon="shield" title="No open tickets">When a customer reports a problem, the assistant collects the details and the ticket appears here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Tickets" hrefFor={(n) => `/dashboard/tickets${buildQuery({ status: status === "open_all" ? null : status, q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
