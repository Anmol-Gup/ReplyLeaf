import Link from "next/link";
import { requireClient } from "../../../lib/auth/session";
import { fmt } from "../../../lib/dashboard";
import Notice from "../Notice";

export default async function Contacts({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data } = await db.from("contacts")
    .select("id, name, phone, email, status, tags, suggested, created_at")
    .order("created_at", { ascending: false }).limit(500);
  return (
    <section className="card">
      <h1>Contacts</h1>
      <Notice code={notice} />
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Tags</th><th>Added</th></tr></thead>
        <tbody>
          {(data ?? []).map((c) => {
            const pending = Object.keys((c.suggested as object) ?? {}).length;
            return (
              <tr key={c.id}>
                <td><Link href={`/dashboard/contacts/${c.id}`}>{c.name || "(no name)"}</Link>{pending > 0 && <> <span className="badge human">{pending} suggestion{pending > 1 ? "s" : ""}</span></>}</td>
                <td>+{c.phone}</td><td>{c.email ?? "-"}</td><td><span className="badge">{c.status}</span></td>
                <td>{(c.tags as string[]).join(", ") || "-"}</td><td>{fmt(c.created_at)}</td>
              </tr>
            );
          })}
          {(data ?? []).length === 0 && <tr><td colSpan={6} className="muted">No contacts yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
