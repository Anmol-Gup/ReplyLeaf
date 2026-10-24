import { requireClient } from "../../../lib/auth/session";
import { fmt } from "../../../lib/dashboard";
import { setBookingStatus } from "../actions";

export default async function Bookings() {
  const { db } = await requireClient();
  const { data: rows } = await db.from("booking_requests")
    .select("id, contact_id, service, preferred_time, name, status, created_at")
    .order("created_at", { ascending: false }).limit(200);
  const { data: contacts } = await db.from("contacts").select("id, name, phone").in("id", (rows ?? []).map((r) => r.contact_id));
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));
  const sorted = [...(rows ?? [])].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));

  return (
    <section className="card">
      <h1>Booking requests</h1>
      <p className="muted">These are requests, not bookings. Confirm or decline each one, then tell the customer yourself (take over the conversation).</p>
      <table>
        <thead><tr><th>Customer</th><th>Service</th><th>Preferred time</th><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {sorted.map((r) => {
            const c = byId.get(r.contact_id);
            return (
              <tr key={r.id}>
                <td>{c?.name || "-"} <span className="muted">+{c?.phone}</span><br /><span className="muted">{fmt(r.created_at)}</span></td>
                <td>{r.service}</td><td>{r.preferred_time}</td><td>{r.name}</td>
                <td><span className={`badge ${r.status === "pending" ? "human" : r.status === "confirmed" ? "ok" : ""}`}>{r.status}</span></td>
                <td>{r.status === "pending" && (
                  <div className="row">
                    {(["confirmed", "declined"] as const).map((s) => (
                      <form key={s} action={setBookingStatus}>
                        <input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value={s} />
                        <button className={s === "declined" ? "secondary" : ""} type="submit">{s === "confirmed" ? "Confirm" : "Decline"}</button>
                      </form>
                    ))}
                  </div>
                )}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && <tr><td colSpan={6} className="muted">No booking requests yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
