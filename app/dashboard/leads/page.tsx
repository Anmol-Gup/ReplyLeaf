import Link from "next/link";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmtDay, matches } from "../../../lib/dashboard";
import { isOpenLead, LEAD_LABELS, LEAD_STATUSES, LEAD_TONES, leadOverview, type LeadStatus } from "../../../lib/leads";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";

type Row = {
  id: string; customer_name: string | null; customer_phone: string; project_type: string; budget: string | null; timeline: string | null;
  status: LeadStatus; follow_up_at: string | null; created_at: string;
};

export default async function Leads({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string; page?: string }> }) {
  const { notice, q, status: statusRaw, page: pageRaw } = await searchParams;
  const status = statusRaw === "open" || (LEAD_STATUSES as readonly string[]).includes(statusRaw ?? "") ? (statusRaw as string) : "all";
  const { db } = await requireClient(); // RLS: only this business's rows can come back
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db.from("leads")
    .select("id, customer_name, customer_phone, project_type, budget, timeline, status, follow_up_at, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const all = (data ?? []) as Row[];
  const o = leadOverview(all, today);
  const count = (s: string) => s === "all" ? all.length : s === "open" ? all.filter((r) => isOpenLead(r.status)).length : all.filter((r) => r.status === s).length;

  const matching = all.filter((r) =>
    (status === "all" || (status === "open" ? isOpenLead(r.status) : r.status === status)) &&
    matches(q, r.customer_name, r.customer_phone, r.project_type, r.budget, r.timeline, LEAD_LABELS[r.status]));
  const paged = paginate(matching, pageRaw, 15);
  const tabs = [{ key: "all", label: "All" }, { key: "open", label: "Open" }, ...LEAD_STATUSES.map((s) => ({ key: s as string, label: LEAD_LABELS[s] }))];

  return (
    <>
      <PageHeader title="Leads" description="Project enquiries collected by the assistant, with what the customer asked for. Update the status as you follow up." />
      <Notice code={notice} />
      <div className="stat-grid">
        <Stat value={o.fresh} label="New or qualified" />
        <Stat value={o.dueFollowUp} label="Follow-ups due" />
        <Stat value={o.open} label="Open leads" />
        <Stat value={o.won} label="Won" />
      </div>
      <nav className="tabs" aria-label="Filter by status">
        {tabs.map((t) => (
          <Link key={t.key} href={`/dashboard/leads${buildQuery({ status: t.key === "all" ? null : t.key, q })}`}
            className={`tab${status === t.key ? " active" : ""}`} aria-current={status === t.key ? "page" : undefined}>
            {t.label} <span className="tab-count">{count(t.key)}</span>
          </Link>
        ))}
      </nav>
      <SearchBox q={q} placeholder="Search by name, phone, project, budget or status" />
      {error ? <ErrorState>Your leads could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Project</th><th>Budget</th><th>Timeline</th><th>Status</th><th>Follow up</th><th>Received</th></tr></thead>
            <tbody>
              {paged.items.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/leads/${r.id}`}>{r.customer_name || "(no name)"}</Link><br /><span className="muted">+{r.customer_phone}</span></td>
                  <td>{clip(r.project_type, 60)}</td>
                  <td>{r.budget ?? "-"}</td>
                  <td>{r.timeline ?? "-"}</td>
                  <td><Badge tone={LEAD_TONES[r.status]}>{LEAD_LABELS[r.status]}</Badge></td>
                  <td>{r.follow_up_at ? <span className={isOpenLead(r.status) && r.follow_up_at <= today ? "due" : undefined}>{r.follow_up_at}</span> : "-"}</td>
                  <td>{fmtDay(r.created_at)}</td>
                </tr>
              ))}
              {paged.items.length === 0 && (
                <tr><td colSpan={7}>
                  {q || status !== "all"
                    ? <EmptyState icon="search" title="No matching leads" action={{ href: "/dashboard/leads", label: "Show all leads" }}>Nothing matches this view.</EmptyState>
                    : <EmptyState icon="users" title="No leads yet">When a customer describes a project or service they need, the assistant collects the details and the lead appears here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Leads" hrefFor={(n) => `/dashboard/leads${buildQuery({ status: status === "all" ? null : status, q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
