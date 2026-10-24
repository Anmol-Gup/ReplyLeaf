import Link from "next/link";
import SubmitButton from "../../../components/SubmitButton";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, type Tone } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmtDay, fmtTime, matches } from "../../../lib/dashboard";
import { setBookingStatus } from "../actions";

const TONE: Record<string, Tone> = { pending: "warn", confirmed: "success", declined: "muted" };
const FILTERS = ["all", "pending", "confirmed", "declined"] as const;

export default async function Bookings({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const { q, status } = await searchParams;
  const { db } = await requireClient();
  const { data: all, error } = await db.from("booking_requests")
    .select("id, contact_id, service, preferred_time, name, status, created_at")
    .order("created_at", { ascending: false }).limit(200);
  const { data: contacts } = await db.from("contacts").select("id, name, phone").in("id", (all ?? []).map((r) => r.contact_id));
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));

  const active = FILTERS.includes(status as (typeof FILTERS)[number]) ? (status as string) : "all";
  const rows = (all ?? [])
    .filter((r) => active === "all" || r.status === active)
    .filter((r) => { const c = byId.get(r.contact_id); return matches(q, r.service, r.name, r.preferred_time, c?.name, c?.phone); })
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  const link = (s: string) => `/dashboard/bookings?${new URLSearchParams({ ...(q ? { q } : {}), ...(s !== "all" ? { status: s } : {}) })}`;

  return (
    <>
      <PageHeader title="Booking requests" description="These are requests, not bookings. Confirm or decline each one, then tell the customer yourself from the conversation." />
      <div className="spread">
        <SearchBox q={q} placeholder="Search by customer, service or time" />
        <div className="row" role="group" aria-label="Filter by status">
          {FILTERS.map((s) => (
            <Link key={s} href={link(s)} className={`btn btn-sm ${active === s ? "btn-primary" : "btn-secondary"}`} aria-current={active === s ? "true" : undefined}>
              {s[0].toUpperCase() + s.slice(1)}
            </Link>
          ))}
        </div>
      </div>
      {error ? <ErrorState>Booking requests could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Service</th><th>Preferred time</th><th>Name</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const c = byId.get(r.contact_id);
                return (
                  <tr key={r.id}>
                    <td>{c?.name || "-"} <span className="muted">+{c?.phone} · {fmtDay(r.created_at)} {fmtTime(r.created_at)}</span></td>
                    <td>{r.service}</td><td>{r.preferred_time}</td><td>{r.name}</td>
                    <td><Badge tone={TONE[r.status] ?? "muted"}>{r.status}</Badge></td>
                    <td>
                      {r.status === "pending" && (
                        <div className="row">
                          {(["confirmed", "declined"] as const).map((s) => (
                            <form key={s} action={setBookingStatus}>
                              <input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value={s} />
                              <SubmitButton small variant={s === "confirmed" ? "primary" : "secondary"} pendingText="Saving...">{s === "confirmed" ? "Confirm" : "Decline"}</SubmitButton>
                            </form>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6}>
                  {q || active !== "all"
                    ? <EmptyState icon="search" title="No matching requests" action={{ href: "/dashboard/bookings", label: "Clear filters" }} />
                    : <EmptyState icon="calendar" title="No booking requests yet">When a customer asks to book and you have no booking link, the request shows up here.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
