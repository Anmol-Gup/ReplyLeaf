import Link from "next/link";
import MultiSelectFilter from "../../../components/MultiSelectFilter";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmtDay, matches } from "../../../lib/dashboard";
import { effectiveSelection } from "../../../lib/filters";
import { APPOINTMENT_STATUSES, isUpcoming, overview, STATUS_LABELS, STATUS_TONES, whenText, type AppointmentStatus } from "../../../lib/appointments";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";

type Row = {
  id: string; customer_name: string | null; customer_phone: string; purpose: string; preferred_date: string | null; preferred_time: string | null;
  scheduled_date: string | null; scheduled_time: string | null; status: AppointmentStatus; created_at: string;
};

export default async function Appointments({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string | string[]; upcoming?: string; page?: string }> }) {
  const { notice, q, status: statusRaw, upcoming: upcomingRaw, page: pageRaw } = await searchParams;
  // Nothing chosen = the requests that are waiting for you.
  const { selected: statuses, explicit } = effectiveSelection(statusRaw, APPOINTMENT_STATUSES, ["pending", "reschedule_requested"]);
  const onlyUpcoming = upcomingRaw === "1";
  const { db } = await requireClient(); // RLS: only this business's rows can come back
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db.from("appointments")
    .select("id, customer_name, customer_phone, purpose, preferred_date, preferred_time, scheduled_date, scheduled_time, status, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const all = (data ?? []) as Row[];
  const o = overview(all, today);
  const options = APPOINTMENT_STATUSES.map((st) => ({ value: st as string, label: STATUS_LABELS[st], count: all.filter((r) => r.status === st).length }));

  const matching = all.filter((r) => statuses.includes(r.status) && (!onlyUpcoming || isUpcoming(r, today)) && matches(q, r.customer_name, r.customer_phone, r.purpose, r.preferred_date, r.preferred_time, STATUS_LABELS[r.status]));
  const paged = paginate(matching, pageRaw, 15);
  const keepStatus = explicit ? statuses : [];
  const href = (n: number) => `/dashboard/appointments${buildQuery({ status: keepStatus, upcoming: onlyUpcoming ? "1" : null, q, page: n > 1 ? n : null })}`;

  return (
    <>
      <PageHeader title="Appointments" description="Appointment requests collected by the assistant. Nothing is booked until you confirm it. Working hours are information only: there is no calendar connection." />
      <Notice code={notice} />
      <div className="stat-grid">
        <Stat value={o.pending} label="Waiting for you" />
        <Stat value={o.upcoming} label="Upcoming" />
        <Stat value={o.confirmed} label="Confirmed in total" />
        <Stat value={o.closed} label="Rejected or cancelled" />
      </div>
      <div className="filters">
        <MultiSelectFilter action="/dashboard/appointments" options={options} selected={statuses} hidden={{ q, upcoming: onlyUpcoming ? "1" : undefined }} />
        <Link className={`tab${onlyUpcoming ? " active" : ""}`} aria-pressed={onlyUpcoming}
          href={`/dashboard/appointments${buildQuery({ status: keepStatus, upcoming: onlyUpcoming ? null : "1", q })}`}>Upcoming only</Link>
        <SearchBox q={q} placeholder="Search by name, phone, purpose or date" keep={{ status: keepStatus, upcoming: onlyUpcoming ? "1" : undefined }} />
      </div>
      {error ? <ErrorState>Your appointments could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>For</th><th>Preferred</th><th>Status</th><th>Requested</th></tr></thead>
            <tbody>
              {paged.items.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/appointments/${r.id}`}>{r.customer_name || "(no name)"}</Link><br /><span className="muted">+{r.customer_phone}</span></td>
                  <td>{r.purpose}</td>
                  <td>{whenText(r.scheduled_date ?? r.preferred_date, r.scheduled_time ?? r.preferred_time) || "-"}</td>
                  <td><Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge></td>
                  <td>{fmtDay(r.created_at)}</td>
                </tr>
              ))}
              {paged.items.length === 0 && (
                <tr><td colSpan={5}>
                  {q || explicit || onlyUpcoming
                    ? <EmptyState icon="search" title="Nothing here" action={{ href: "/dashboard/appointments", label: "Show requests that need action" }}>No appointments match this view.</EmptyState>
                    : <EmptyState icon="calendar" title="No requests waiting">When a customer asks to book and no booking link is set, the assistant collects the details and the request appears here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Appointments" hrefFor={href} />}
    </>
  );
}
