import Link from "next/link";
import { notFound } from "next/navigation";
import SubmitButton from "../../../../components/SubmitButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
import { fmt } from "../../../../lib/dashboard";
import { whatsappLink } from "../../../../lib/appointments";
import { PRIORITIES, PRIORITY_LABELS, TICKET_LABELS, TICKET_STATUSES, TICKET_TONES, ticketRef, type TicketStatus } from "../../../../lib/tickets";
import Notice from "../../Notice";
import { updateTicket } from "../actions";

export default async function TicketDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: t } = await db.from("tickets").select("*").eq("id", id).maybeSingle();
  if (!t) notFound(); // also what another business's id looks like: RLS returns nothing

  const { data: contact } = await db.from("contacts").select("id, email").eq("id", t.contact_id).maybeSingle();
  const emailOf = (await emailsByContact(db, [t.contact_id])).get(t.contact_id) ?? contact?.email ?? null;
  const status = t.status as TicketStatus;
  // A chat with the customer from your own phone (the WhatsApp Business app): free, no template, no 24-hour rule.
  const link = whatsappLink(t.customer_phone);

  return (
    <>
      <PageHeader
        title={`${ticketRef(t.id)}: ${t.subject}`}
        description={`${t.customer_name || "Customer"} · +${t.customer_phone}${emailOf ? ` · ${emailOf}` : ""} · raised ${fmt(t.created_at)}`}
        actions={<span className="row">{link && <a className="btn btn-secondary btn-sm" href={link} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}<a className="btn btn-primary btn-sm" href="#edit">Edit</a><Link className="btn btn-secondary btn-sm" href="/dashboard/tickets">All tickets</Link></span>}
      />
      <Notice code={notice} />
      <Card title="The problem" actions={<span className="row">{t.priority === "high" && <Badge tone="danger">Urgent</Badge>}<Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge></span>}>
        <dl className="handoff-facts">
          <div><dt>What happened</dt><dd>{t.description}</dd></div>
          {t.category && <div><dt>Category</dt><dd>{t.category}</dd></div>}
          {t.reference_info && <div><dt>Reference given</dt><dd>{t.reference_info}</dd></div>}
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href={`/dashboard/conversations/${t.conversation_id}`}>Open the conversation</Link>
          {contact && <> · <Link href={`/dashboard/contacts/${contact.id}`}>Contact details</Link></>}
        </p>
      </Card>

      <div id="edit"><Card title="Edit ticket" description="Set the status and priority, assign it, and keep private notes. Notes and the assignee are never sent to the customer.">
        <form action={updateTicket} className="stack">
          <input type="hidden" name="id" value={t.id} />
          <div className="row">
            <label className="field">Status
              <select name="status" defaultValue={status}>{TICKET_STATUSES.map((s) => <option key={s} value={s}>{TICKET_LABELS[s]}</option>)}</select>
            </label>
            <label className="field">Priority
              <select name="priority" defaultValue={t.priority === "high" ? "high" : "normal"}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select>
            </label>
            <label className="field">Assigned to <input name="assigned_to" maxLength={100} defaultValue={t.assigned_to ?? ""} placeholder="Name or email" /></label>
          </div>
          <label className="field">Internal notes <textarea name="notes" rows={4} maxLength={4000} defaultValue={t.internal_notes ?? ""} /></label>
          {!(status === "resolved" || status === "closed") && (
            <fieldset className="field">
              <legend>When you mark it resolved or closed</legend>
              <label className="check"><input type="checkbox" name="notify" /> Tell the customer (WhatsApp if the 24-hour window is open, otherwise email if we have it)</label>
              <label className="field">Optional line for the customer <textarea name="message" rows={2} maxLength={1000} placeholder="For example: a replacement ships today." /></label>
            </fieldset>
          )}
          <div><SubmitButton pendingText="Saving...">Save</SubmitButton></div>
        </form>
      </Card></div>
    </>
  );
}
