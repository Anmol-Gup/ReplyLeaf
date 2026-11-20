import Link from "next/link";
import { notFound } from "next/navigation";
import AppointmentEditForm from "../../../../components/AppointmentEditForm";
import SubmitButton from "../../../../components/SubmitButton";
import { Alert, Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { fmt, windowStatus } from "../../../../lib/dashboard";
import {
  allowedActions, APPOINTMENT_STATUSES, customerMessage, STATUS_LABELS, STATUS_TONES, whatsappLink, whenWithZone, type AppointmentAction, type AppointmentStatus,
} from "../../../../lib/appointments";
import { parseWorkflowSettings } from "../../../../lib/workflow-settings";
import Notice from "../../Notice";
import { appointmentTransition, saveAppointmentNote, updateAppointment } from "../actions";

export default async function AppointmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, clientName } = await requireClient();
  const { data: a } = await db.from("appointments").select("*").eq("id", id).maybeSingle();
  if (!a) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: conv }, { data: contact }] = await Promise.all([
    db.from("conversations").select("id, last_customer_message_at").eq("id", a.conversation_id).maybeSingle(),
    db.from("contacts").select("id, email").eq("id", a.contact_id).maybeSingle(),
  ]);
  const status = a.status as AppointmentStatus;
  const actions = allowedActions(status);
  const can = (x: AppointmentAction) => actions.includes(x);
  const w = windowStatus(conv?.last_customer_message_at);
  // The zone times are in: the appointment's own, else the business's setting.
  const { data: biz } = await db.from("clients").select("workflow_settings").eq("id", a.client_id).maybeSingle();
  const zone = (a.timezone as string | null)?.trim() || parseWorkflowSettings(biz?.workflow_settings).appointments.timezone;
  const prefer = whenWithZone(a.preferred_date, a.preferred_time, zone);
  const scheduled = whenWithZone(a.scheduled_date, a.scheduled_time, zone);

  // The text the customer gets for the CURRENT status (shown so it can be sent by hand if they could not be reached).
  const manual = status === "confirmed" ? customerMessage("confirm", { purpose: a.purpose, when: scheduled }, clientName)
    : status === "rejected" ? customerMessage("reject", { purpose: a.purpose, when: prefer, note: a.reschedule_note }, clientName)
    : status === "reschedule_requested" ? customerMessage("reschedule", { purpose: a.purpose, when: prefer, note: a.reschedule_note }, clientName)
    : status === "cancelled" ? customerMessage("cancel", { purpose: a.purpose, when: scheduled || prefer }, clientName) : null;

  const hidden = (action: AppointmentAction) => (<><input type="hidden" name="id" value={a.id} /><input type="hidden" name="action" value={action} /></>);

  return (
    <>
      <PageHeader
        title={a.customer_name || "Appointment request"}
        description={`+${a.customer_phone} · requested ${fmt(a.created_at)}`}
        actions={<span className="row"><a className="btn btn-primary btn-sm" href="#edit">Edit appointment</a><Link className="btn btn-secondary btn-sm" href="/dashboard/appointments">All appointments</Link></span>}
      />
      <Notice code={notice} />
      <Card title="Request" actions={<Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>}>
        <dl className="handoff-facts">
          <div><dt>For</dt><dd>{a.purpose}</dd></div>
          <div><dt>Preferred</dt><dd>{prefer || "-"}</dd></div>
          {scheduled && <div><dt>Scheduled</dt><dd>{scheduled}</dd></div>}
          <div><dt>Type</dt><dd>{a.appointment_type === "online" ? "Online" : a.appointment_type === "in_person" ? "In person" : "Not said"}</dd></div>
          <div><dt>Time zone</dt><dd>{a.timezone || "Not said"}</dd></div>
          <div><dt>Customer notes</dt><dd>{a.notes || "-"}</dd></div>
          {a.reschedule_note && <div><dt>{status === "rejected" ? "Reason shown to customer" : "Suggested alternative"}</dt><dd>{a.reschedule_note}</dd></div>}
          <div><dt>Email on file</dt><dd>{contact?.email || "None"}</dd></div>
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href={`/dashboard/conversations/${a.conversation_id}`}>Open the conversation</Link>
          {" · "}WhatsApp window: {w.label}
        </p>
      </Card>

      {/* The quick actions. A pending request can be confirmed, rescheduled or rejected; a confirmed one rescheduled, cancelled or completed;
          rejected, cancelled and completed ones have none (you can still edit them below). */}
      {actions.filter((x) => !(status === "pending" && x === "cancel")).length > 0 ? (
        <Card title="Decide" description="The customer is told by WhatsApp if their 24-hour window is open, otherwise by email if they gave one. If neither works you will see it and can use Send from WhatsApp.">
          <div className="stack-sm">
            {can("confirm") && (
              <form action={appointmentTransition} className="stack-sm">
                {hidden("confirm")}
                <div className="grid2">
                  <label className="field">Scheduled date <input type="date" name="date" required defaultValue={a.preferred_date ?? ""} /></label>
                  <label className="field">Scheduled time{zone ? ` (${zone})` : ""} <input name="time" required maxLength={60} defaultValue={a.preferred_time ?? ""} placeholder="10:30 or 3pm" /></label>
                </div>
                <div><SubmitButton pendingText="Confirming...">Confirm appointment</SubmitButton> <span className="hint">The customer&apos;s preferred date and time are kept as they asked.</span></div>
              </form>
            )}
            {can("reschedule") && (
              <details className="handoff-more">
                <summary>Ask the customer to reschedule</summary>
                <form action={appointmentTransition} className="stack-sm" style={{ marginTop: 10 }}>
                  {hidden("reschedule")}
                  <div className="grid2">
                    <label className="field">Suggested date <input type="date" name="date" /></label>
                    <label className="field">Suggested time <input name="time" maxLength={60} placeholder="3pm" /></label>
                  </div>
                  <label className="field">Message <span className="hint">Shown to the customer.</span><input name="note" maxLength={500} placeholder="For example: we are fully booked that day" /></label>
                  <div><SubmitButton variant="secondary" pendingText="Sending...">Send reschedule request</SubmitButton></div>
                </form>
              </details>
            )}
            {can("reject") && (
              <details className="handoff-more">
                <summary>Reject this request</summary>
                <form action={appointmentTransition} className="stack-sm" style={{ marginTop: 10 }}>
                  {hidden("reject")}
                  <label className="field">Reason <span className="hint">Optional. Shown to the customer.</span><input name="note" maxLength={500} /></label>
                  <div><SubmitButton variant="danger" pendingText="Rejecting...">Reject and tell the customer</SubmitButton></div>
                </form>
              </details>
            )}
            {can("cancel") && status !== "pending" && (
              <details className="handoff-more">
                <summary>Cancel this appointment</summary>
                <form action={appointmentTransition} className="stack-sm" style={{ marginTop: 10 }}>
                  {hidden("cancel")}
                  <p className="muted">The customer will be told it is cancelled. This cannot be undone with a button, but you can edit the status below.</p>
                  <div><SubmitButton variant="danger" pendingText="Cancelling...">Cancel and tell the customer</SubmitButton></div>
                </form>
              </details>
            )}
            {can("complete") && (
              <form action={appointmentTransition}>
                {hidden("complete")}
                <SubmitButton variant="secondary" pendingText="Saving...">Mark as completed</SubmitButton>
              </form>
            )}
          </div>
        </Card>
      ) : (
        <p className="muted">This appointment is {STATUS_LABELS[status].toLowerCase()}, so there are no quick actions. You can still change anything in Edit appointment below.</p>
      )}

      {manual && (
        <Card title="Message for the customer" description="This is what the customer is sent for the current status. If they could not be reached, copy it and send it yourself.">
          <p className="note" style={{ whiteSpace: "pre-wrap" }}>{manual}</p>
          {whatsappLink(a.customer_phone, manual) && (
            <p style={{ marginTop: 10 }}>
              <a className="btn btn-secondary btn-sm" href={whatsappLink(a.customer_phone, manual) ?? "#"} target="_blank" rel="noopener noreferrer">Send from WhatsApp</a>{" "}
              <span className="hint">Opens WhatsApp with this message ready; press send on your phone. It is a normal chat message, not an API message or a template, so Meta does not charge for it.</span>
            </p>
          )}
        </Card>
      )}

      <div id="edit">
        <Card title="Edit appointment" description="Change any detail or set the status yourself. Nothing is sent to the customer unless you tick the box at the bottom.">
          <AppointmentEditForm action={updateAppointment} zone={zone}
            statuses={APPOINTMENT_STATUSES.map((st) => ({ value: st, label: STATUS_LABELS[st] }))}
            a={{ id: a.id, status, customer_name: a.customer_name, purpose: a.purpose, preferred_date: a.preferred_date, preferred_time: a.preferred_time, scheduled_date: a.scheduled_date, scheduled_time: a.scheduled_time, appointment_type: a.appointment_type, timezone: a.timezone, reschedule_note: a.reschedule_note }} />
        </Card>
      </div>

      <Card title="Internal note" description="Only your team sees this. It is never sent to the customer.">
        <form action={saveAppointmentNote} className="stack-sm">
          <input type="hidden" name="id" value={a.id} />
          <label className="sr-only" htmlFor="notes">Internal note</label>
          <textarea id="notes" name="notes" rows={4} maxLength={2000} defaultValue={a.internal_notes ?? ""} />
          <div><SubmitButton variant="secondary" pendingText="Saving...">Save note</SubmitButton></div>
        </form>
      </Card>
      {status === "pending" && <Alert kind="info">Until you confirm, the customer has only been told that the request was submitted and awaits confirmation.</Alert>}
    </>
  );
}
