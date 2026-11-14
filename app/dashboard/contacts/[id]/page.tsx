import Link from "next/link";
import { notFound } from "next/navigation";
import Icon from "../../../../components/Icon";
import SubmitButton from "../../../../components/SubmitButton";
import { Alert, Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { fmtDay } from "../../../../lib/dashboard";
import { buildTimeline } from "../../../../lib/timeline";
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
  // Everything this customer has raised, across leads, appointments, tickets and handoffs (RLS limits all of it to this business).
  const [leads, appts, tickets, handoffs] = await Promise.all([
    db.from("leads").select("id, project_type, budget, status, created_at").eq("contact_id", id),
    db.from("appointments").select("id, purpose, preferred_date, preferred_time, scheduled_date, scheduled_time, status, created_at").eq("contact_id", id),
    db.from("tickets").select("id, subject, priority, status, created_at").eq("contact_id", id),
    conv ? db.from("handoff_requests").select("id, conversation_id, reason, status, created_at").eq("conversation_id", conv.id) : Promise.resolve({ data: [] }),
  ]);
  const timeline = buildTimeline({
    leads: (leads.data ?? []) as never[], appointments: (appts.data ?? []) as never[],
    tickets: (tickets.data ?? []) as never[], handoffs: (handoffs.data ?? []) as never[],
  });

  return (
    <>
      <Link href="/dashboard/contacts" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}><Icon name="back" size={16} /> All contacts</Link>
      <PageHeader
        title={c.name || "Contact"} description={`+${c.phone}`}
        actions={conv ? <Link className="btn btn-secondary" href={`/dashboard/conversations/${conv.id}`}><Icon name="chat" size={16} /> Open conversation</Link> : undefined}
      />
      <Notice code={notice} />

      {Object.entries(suggested).map(([field, value]) => (
        <Alert key={field} kind="warn">
          <p>The assistant picked up a possible <b>{field}</b> from the chat: <b>{value}</b>. Current value: <b>{((c as Record<string, unknown>)[field] as string) || "(empty)"}</b>. It is only a guess, so it has not been applied.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <form action={resolveSuggestion}>
              <input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} /><input type="hidden" name="accept" value="yes" />
              <SubmitButton small pendingText="Saving...">Use this {field}</SubmitButton>
            </form>
            <form action={resolveSuggestion}>
              <input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} />
              <SubmitButton small variant="secondary" pendingText="Dismissing...">Dismiss</SubmitButton>
            </form>
          </div>
        </Alert>
      ))}

      <Card title="Activity" description="Everything this customer has asked for or reported, newest first.">
        {timeline.length === 0 ? <p className="muted">Nothing yet: no enquiries, appointments, tickets or handoffs.</p> : (
          <ul className="timeline">
            {timeline.map((t) => (
              <li key={`${t.kind}-${t.id}`}>
                <span className="muted">{fmtDay(t.at)}</span>
                <span><Link href={t.href}>{t.title}</Link>{t.detail && <span className="muted"> · {t.detail}</span>}</span>
                <Badge tone={t.tone}>{t.statusLabel}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Details">
        <form action={updateContact} className="stack">
          <input type="hidden" name="id" value={id} />
          <label className="field">Name<input name="name" defaultValue={c.name ?? ""} maxLength={100} /></label>
          <label className="field">Email<input name="email" type="email" defaultValue={c.email ?? ""} maxLength={200} /></label>
          <label className="field">Status
            <select name="status" defaultValue={c.status}>
              {["new", "lead", "customer", "lost"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="field">Tags <span className="hint">Comma separated</span><input name="tags" defaultValue={(c.tags as string[]).join(", ")} /></label>
          <label className="field">Notes<textarea name="notes" defaultValue={c.notes ?? ""} maxLength={2000} /></label>
          <div><SubmitButton pendingText="Saving...">Save changes</SubmitButton></div>
        </form>
      </Card>

      <Card title="Delete this person's data" description="Permanently deletes this contact, their conversation and messages. Use it when someone asks for their data to be erased. It cannot be undone.">
        <form action={deleteContact} className="row">
          <input type="hidden" name="id" value={id} />
          <label className="check"><input type="checkbox" name="confirm" value="yes" required /> I understand this is permanent</label>
          <SubmitButton variant="danger" pendingText="Deleting...">Delete contact and messages</SubmitButton>
        </form>
        <p style={{ marginTop: 10 }}><Badge tone="danger">Permanent</Badge></p>
      </Card>
    </>
  );
}
