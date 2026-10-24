import Link from "next/link";
import { requireClient } from "../../../lib/auth/session";
import { fmt } from "../../../lib/dashboard";
import { isWithinWindow } from "../../../lib/whatsapp/window";
import AutoRefresh from "../AutoRefresh";

export default async function Conversations() {
  const { db } = await requireClient();
  const { data: convs } = await db.from("conversations")
    .select("id, contact_id, handling, last_customer_message_at, updated_at")
    .order("updated_at", { ascending: false }).limit(100);
  const { data: contacts } = await db.from("contacts").select("id, name, phone")
    .in("id", (convs ?? []).map((c) => c.contact_id));
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));
  const rows = [...(convs ?? [])].sort((a, b) => Number(b.handling === "human_active") - Number(a.handling === "human_active"));

  return (
    <section className="card">
      <AutoRefresh />
      <h1>Conversations</h1>
      <table>
        <thead><tr><th>Customer</th><th>Handled by</th><th>Last customer message</th><th>24h window</th></tr></thead>
        <tbody>
          {rows.map((c) => {
            const contact = byId.get(c.contact_id);
            const open = isWithinWindow(c.last_customer_message_at ? new Date(c.last_customer_message_at) : null);
            return (
              <tr key={c.id}>
                <td><Link href={`/dashboard/conversations/${c.id}`}>{contact?.name || `+${contact?.phone}`}</Link> <span className="muted">+{contact?.phone}</span></td>
                <td><span className={`badge ${c.handling === "human_active" ? "human" : "ok"}`}>{c.handling === "human_active" ? "You (waiting)" : "Assistant"}</span></td>
                <td>{fmt(c.last_customer_message_at)}</td>
                <td>{open ? "open" : <span className="muted">closed</span>}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">No conversations yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
