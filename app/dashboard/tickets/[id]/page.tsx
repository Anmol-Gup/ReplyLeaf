import Link from "next/link";
import { notFound } from "next/navigation";
import ChatLog from "../../../../components/ChatLog";
import SubmitButton from "../../../../components/SubmitButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
import { fmt, fmtDay, fmtTime } from "../../../../lib/dashboard";
import { whatsappLink } from "../../../../lib/appointments";
import { isDone, resolutionMessage, TICKET_LABELS, TICKET_STATUSES, TICKET_TONES, ticketRef, type TicketStatus } from "../../../../lib/tickets";
import Notice from "../../Notice";
import { updateTicket } from "../actions";

export default async function TicketDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, clientName } = await requireClient();
  const { data: t } = await db.from("tickets").select("*").eq("id", id).maybeSingle();
  if (!t) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: contact }, { data: messages }] = await Promise.all([
    db.from("contacts").select("id, email").eq("id", t.contact_id).maybeSingle(),
    db.from("messages").select("id, sender, type, body, created_at").eq("conversation_id", t.conversation_id).order("created_at", { ascending: false }).limit(100),
  ]);
  const chat = [...(messages ?? [])].reverse();
  const emailOf = (await emailsByContact(db, [t.contact_id])).get(t.contact_id) ?? contact?.email ?? null;
  const status = t.status as TicketStatus;
  // A message you can send yourself from your own phone (the WhatsApp Business app): free, no template, no 24-hour rule.
  const message = isDone(status)
    ? resolutionMessage(clientName, t.subject, ticketRef(t.id), "")
    : `Hi${t.customer_name ? ` ${t.customer_name}` : ""}, this is ${clientName} about your issue ${ticketRef(t.id)} (${t.subject}). We are looking into it and will update you here.`;
  const link = whatsappLink(t.customer_phone, message);

  return (
    <>
      <PageHeader
        title={`${ticketRef(t.id)}: ${t.subject}`}
        description={`${t.customer_name || "Customer"} · +${t.customer_phone}${emailOf ? ` · ${emailOf}` : ""} · raised ${fmt(t.created_at)}`}
        actions={<Link className="btn btn-secondary btn-sm" href="/dashboard/tickets">All tickets</Link>}
      />
      <Notice code={notice} />
      <Card title="The problem" actions={<span className="row">{t.priority === "high" && <Badge tone="danger">Urgent</Badge>}<Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge></span>}>
        <dl className="handoff-facts">
          <div><dt>AI summary</dt><dd>{t.ai_summary || "-"}</dd></div>
          <div><dt>What happened</dt><dd>{t.description}</dd></div>
          <div><dt>Category</dt><dd>{t.category ?? "Not set"}</dd></div>
          <div><dt>Reference given</dt><dd>{t.reference_info ?? "None"}</dd></div>
          {t.resolved_at && <div><dt>Resolved</dt><dd>{fmt(t.resolved_at)}</dd></div>}
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href={`/dashboard/conversations/${t.conversation_id}`}>Open the conversation to reply</Link>
          {contact && <> · <Link href={`/dashboard/contacts/${contact.id}`}>Contact details</Link></>}
        </p>
      </Card>

      <Card title="Manage" description="Notes and the assignee stay private. They are never sent to the customer.">
        <form action={updateTicket} className="stack">
          <input type="hidden" name="id" value={t.id} />
          <div className="row">
            <label className="field">Status
              <select name="status" defaultValue={status}>{TICKET_STATUSES.map((s) => <option key={s} value={s}>{TICKET_LABELS[s]}</option>)}</select>
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
      </Card>

      {link && (
        <Card title="Message the customer yourself" description="Opens WhatsApp with this message ready; press send on your phone. It is a normal chat message, not an API message or a template, so Meta does not charge for it and the 24-hour rule does not apply.">
          <p className="note" style={{ whiteSpace: "pre-wrap" }}>{message}</p>
          <p style={{ marginTop: 10 }}><a className="btn btn-secondary btn-sm" href={link} target="_blank" rel="noopener noreferrer">Send from WhatsApp</a></p>
        </Card>
      )}

      <Card title="WhatsApp conversation">
        <ChatLog>
          {chat.map((m, i) => (
            <div key={m.id} style={{ display: "contents" }}>
              {(i === 0 || fmtDay(chat[i - 1].created_at) !== fmtDay(m.created_at)) && <span className="day">{fmtDay(m.created_at)}</span>}
              <div className={`bubble ${m.sender}`}>
                {m.sender !== "customer" && <span className="tag">{m.sender === "bot" ? "Assistant" : "You"}</span>}
                {m.body ?? (m.type !== "text" ? `[${m.type} message]` : "[deleted by retention policy]")}
                <time dateTime={m.created_at}>{fmtTime(m.created_at)} UTC</time>
              </div>
            </div>
          ))}
        </ChatLog>
      </Card>
    </>
  );
}
