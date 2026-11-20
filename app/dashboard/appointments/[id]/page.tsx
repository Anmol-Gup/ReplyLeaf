import Link from "next/link";
import { notFound } from "next/navigation";
import AppointmentEditForm from "../../../../components/AppointmentEditForm";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { fmt } from "../../../../lib/dashboard";
import { OWNER_STATUSES, STATUS_LABELS, STATUS_TONES, whatsappLink, whenText, type AppointmentStatus } from "../../../../lib/appointments";
import Notice from "../../Notice";
import { updateAppointment } from "../actions";

// One appointment: what the customer asked for, a way to contact them, and a small form to record the outcome. The owner talks to the
// customer directly; nothing here is sent to them.
export default async function AppointmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: a } = await db.from("appointments").select("*").eq("id", id).maybeSingle();
  if (!a) notFound(); // also what another business's id looks like: RLS returns nothing

  const status = a.status as AppointmentStatus;
  const prefer = whenText(a.preferred_date, a.preferred_time);
  const agreed = whenText(a.scheduled_date, a.scheduled_time);
  const contactLink = whatsappLink(a.customer_phone);
  // The owner's four statuses, plus the record's own if it is an older one (so it is never hidden).
  const options = [...new Set<AppointmentStatus>([...OWNER_STATUSES, status])].map((s) => ({ value: s, label: STATUS_LABELS[s] }));

  return (
    <>
      <PageHeader
        title={a.customer_name || "Appointment request"}
        description={`+${a.customer_phone} · requested ${fmt(a.created_at)}`}
        actions={<span className="row">
          {contactLink && <a className="btn btn-secondary btn-sm" href={contactLink} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}
          <Link className="btn btn-ghost btn-sm" href="/dashboard/appointments">All appointments</Link>
        </span>}
      />
      <Notice code={notice} />

      <Card title="Request" actions={<Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>}>
        <dl className="handoff-facts">
          <div><dt>For</dt><dd>{a.purpose}</dd></div>
          <div><dt>Customer asked for</dt><dd>{prefer || "-"}</dd></div>
          {agreed && <div><dt>Agreed</dt><dd>{agreed}</dd></div>}
          {a.notes && <div><dt>Customer notes</dt><dd>{a.notes}</dd></div>}
        </dl>
        <p className="muted" style={{ marginTop: 12 }}><Link href={`/dashboard/conversations/${a.conversation_id}`}>Open the conversation</Link></p>
      </Card>

      <div id="edit">
        <Card title="Update" description="After you have spoken to the customer, set the status here. Nothing is sent to them.">
          <AppointmentEditForm action={updateAppointment} statuses={options}
            a={{ id: a.id, status, scheduled_date: a.scheduled_date, scheduled_time: a.scheduled_time, preferred_date: a.preferred_date, preferred_time: a.preferred_time, internal_notes: a.internal_notes }} />
        </Card>
      </div>
    </>
  );
}
