import Link from "next/link";
import MultiSelectFilter from "../../../components/MultiSelectFilter";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmtDay, matches } from "../../../lib/dashboard";
import { emailsByContact } from "../../../lib/contact-emails";
import { effectiveSelection } from "../../../lib/filters";
import { isOpenLead, LEAD_LABELS, LEAD_STATUSES, LEAD_TONES, leadOverview, type LeadStatus } from "../../../lib/leads";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";

type Row = {
  id: string; contact_id: string; customer_name: string | null; customer_phone: string; project_type: string; description: string | null; budget: string | null; timeline: string | null;
  status: LeadStatus; follow_up_at: string | null; created_at: string;
};

export default async function Leads({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string | string[]; page?: string }> }) {
  const { notice, q, status: statusRaw, page: pageRaw } = await searchParams;
  const { selected: statuses, explicit } = effectiveSelection(statusRaw, LEAD_STATUSES, []); // nothing chosen = every status
  const { db } = await requireClient(); // RLS: only this business's rows can come back
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db.from("leads")
    .select("id, contact_id, customer_name, customer_phone, project_type, description, budget, timeline, status, follow_up_at, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const all = (data ?? []) as Row[];
  const o = leadOverview(all, today);
  const options = LEAD_STATUSES.map((s) => ({ value: s as string, label: LEAD_LABELS[s], count: all.filter((r) => r.status === s).length }));

  const matching = all.filter((r) =>
    (statuses.length === 0 || statuses.includes(r.status)) &&
    matches(q, r.customer_name, r.customer_phone, r.project_type, r.description, r.budget, r.timeline, LEAD_LABELS[r.status]));
  const paged = paginate(matching, pageRaw, 15);
  // What each customer asked for: the collected requirements of the leads on this page (still through the RLS client).
  const ids = paged.items.map((r) => r.id);
  const { data: reqRows } = ids.length ? await db.from("lead_requirements").select("lead_id, requirement_key, requirement_value").in("lead_id", ids).order("created_at") : { data: [] };
  const emails = await emailsByContact(db, paged.items.map((r) => r.contact_id));
  const reqsByLead = new Map<string, string[]>();
  for (const r of reqRows ?? []) reqsByLead.set(r.lead_id as string, [...(reqsByLead.get(r.lead_id as string) ?? []), `${r.requirement_key}: ${r.requirement_value}`]);

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
      <div className="filters">
        <MultiSelectFilter action="/dashboard/leads" options={options} selected={statuses} hidden={{ q }} />
        <SearchBox q={q} placeholder="Search by name, phone, project, requirements, budget or status" keep={{ status: explicit ? statuses : [] }} />
      </div>
      {error ? <ErrorState>Your leads could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Service</th><th>Requirements</th><th>Budget</th><th>Timeline</th><th>Status</th><th>Follow up</th><th>Received</th><th></th></tr></thead>
            <tbody>
              {paged.items.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/leads/${r.id}`}>{r.customer_name || "(no name)"}</Link><br /><span className="muted">+{r.customer_phone}</span>{emails.get(r.contact_id) && <><br /><span className="muted">{emails.get(r.contact_id)}</span></>}</td>
                  <td className="col-service">
                    <b>{clip(r.project_type, 60)}</b>
                    {r.description && <><br /><span className="muted">{clip(r.description, 110)}</span></>}
                  </td>
                  <td className="col-reqs">
                    {(reqsByLead.get(r.id) ?? []).length > 0
                      ? <ul className="reqs">{(reqsByLead.get(r.id) ?? []).map((t, i) => <li key={i}>{t}</li>)}</ul>
                      : <span className="muted">-</span>}
                  </td>
                  <td>{r.budget ?? "-"}</td>
                  <td>{r.timeline ?? "-"}</td>
                  <td><Badge tone={LEAD_TONES[r.status]}>{LEAD_LABELS[r.status]}</Badge></td>
                  <td>{r.follow_up_at ? <span className={isOpenLead(r.status) && r.follow_up_at <= today ? "due" : undefined}>{r.follow_up_at}</span> : "-"}</td>
                  <td>{fmtDay(r.created_at)}</td>
                  <td><Link className="btn btn-secondary btn-sm" href={`/dashboard/leads/${r.id}#edit`}>Edit</Link></td>
                </tr>
              ))}
              {paged.items.length === 0 && (
                <tr><td colSpan={9}>
                  {q || explicit
                    ? <EmptyState icon="search" title="No matching leads" action={{ href: "/dashboard/leads", label: "Show all leads" }}>Nothing matches this view.</EmptyState>
                    : <EmptyState icon="users" title="No leads yet">When a customer describes a project or service they need, the assistant collects the details and the lead appears here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Leads" hrefFor={(n) => `/dashboard/leads${buildQuery({ status: explicit ? statuses : [], q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
