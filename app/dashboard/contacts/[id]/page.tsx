import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClient } from "../../../../lib/auth/session";
import Notice from "../../Notice";
import { deleteContact, resolveSuggestion, updateContact } from "../../actions";

export default async function ContactPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: c } = await db.from("contacts").select("id, name, phone, email, status, tags, notes, suggested").eq("id", id).maybeSingle();
  if (!c) notFound();
  const suggested = (c.suggested ?? {}) as Record<string, string>;
  const { data: conv } = await db.from("conversations").select("id").eq("contact_id", id).maybeSingle();

  return (
    <section className="card">
      <p><Link href="/dashboard/contacts">&larr; All contacts</Link></p>
      <h1>{c.name || "Contact"} <span className="muted">+{c.phone}</span></h1>
      <Notice code={notice} />
      {conv && <p><Link href={`/dashboard/conversations/${conv.id}`}>Open conversation</Link></p>}

      {Object.entries(suggested).map(([field, value]) => (
        <div key={field} className="notice warn">
          <p style={{ margin: "0 0 8px" }}>The assistant picked up a possible <b>{field}</b> from the chat: <b>{value}</b>. Current value: <b>{(c as Record<string, unknown>)[field] as string || "(empty)"}</b>. It is only a guess, so it has not been applied.</p>
          <div className="row">
            <form action={resolveSuggestion}><input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} /><input type="hidden" name="accept" value="yes" /><button type="submit">Use this {field}</button></form>
            <form action={resolveSuggestion}><input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} /><button className="secondary" type="submit">Dismiss</button></form>
          </div>
        </div>
      ))}

      <form action={updateContact} className="stack">
        <input type="hidden" name="id" value={id} />
        <label>Name<input name="name" defaultValue={c.name ?? ""} maxLength={100} /></label>
        <label>Email<input name="email" type="email" defaultValue={c.email ?? ""} maxLength={200} /></label>
        <label>Status
          <select name="status" defaultValue={c.status}>
            {["new", "lead", "customer", "lost"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Tags (comma separated)<input name="tags" defaultValue={(c.tags as string[]).join(", ")} /></label>
        <label>Notes<textarea name="notes" defaultValue={c.notes ?? ""} maxLength={2000} /></label>
        <div><button type="submit">Save</button></div>
      </form>

      <h2>Delete this person's data</h2>
      <p className="muted">Permanently deletes this contact, their conversation, messages and booking requests. Use this when someone asks for their data to be erased. It cannot be undone.</p>
      <form action={deleteContact} className="row">
        <input type="hidden" name="id" value={id} />
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><input type="checkbox" name="confirm" value="yes" required /> I understand this is permanent</label>
        <button className="danger" type="submit">Delete contact and messages</button>
      </form>
    </section>
  );
}
