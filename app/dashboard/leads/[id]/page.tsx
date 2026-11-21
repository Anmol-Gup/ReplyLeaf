import CustomerCard from "../../../../components/CustomerCard";
import ConfirmForm from "../../../../components/ConfirmForm";
import SubmitButton from "../../../../components/SubmitButton";
import Link from "next/link";
import { notFound } from "next/navigation";
import ChangeAwareSubmit from "../../../../components/ChangeAwareSubmit";
import CopyButton from "../../../../components/CopyButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
import { fmt } from "../../../../lib/dashboard";
import { LEAD_LABELS, LEAD_STATUSES, LEAD_TONES, projectBrief, requirementLines, type LeadStatus } from "../../../../lib/leads";
import Notice from "../../Notice";
import { deleteLead, updateLeadDetails } from "../actions";

export default async function LeadDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, clientName } = await requireClient();
  const { data: l } = await db.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: reqs }, { data: contact }] = await Promise.all([
    db.from("lead_requirements").select("requirement_key, requirement_value").eq("lead_id", id).order("created_at"),
    db.from("contacts").select("id, name, phone, email, status").eq("id", l.contact_id).maybeSingle(),
  ]);
  const emailOf = (await emailsByContact(db, [l.contact_id])).get(l.contact_id) ?? contact?.email ?? null;
  const status = l.status as LeadStatus;
  const brief = projectBrief(l, reqs ?? [], clientName);

  return (
    <>
      <PageHeader
        title={l.customer_name || "Project enquiry"}
        description={`+${l.customer_phone}${emailOf ? ` · ${emailOf}` : ""} · received ${fmt(l.created_at)}`}
        actions={<span className="row"><Link className="btn btn-secondary btn-sm" href="/dashboard/leads">All leads</Link><ConfirmForm action={deleteLead} message="Delete this lead permanently? This cannot be undone."><input type="hidden" name="id" value={l.id} /><SubmitButton variant="danger" small pendingText="Deleting...">Delete</SubmitButton></ConfirmForm></span>}
      />
      <Notice code={notice} />

      <div className="dcols">
        <div className="rec-col">
      <CustomerCard contact={contact} conversationId={l.conversation_id} fallback={{ name: l.customer_name, phone: l.customer_phone }} />
      <Card title={l.project_type} actions={<Badge tone={LEAD_TONES[status]}>{LEAD_LABELS[status]}</Badge>}>
        <dl className="handoff-facts">
          <div><dt>AI summary</dt><dd>{l.ai_summary || "-"}</dd></div>
        </dl>
        {contact && <p className="muted" style={{ marginTop: 12 }}><Link href={`/dashboard/contacts/${contact.id}`}>Contact details</Link></p>}
      </Card>

      <div id="edit">
        <Card title="Edit lead" description="Everything about this lead in one place. The notes and follow-up date stay private and are never sent to the customer. Put one requirement per line as  name: value  (for example  platform: Shopify).">
          <form action={updateLeadDetails} className="stack">
            <input type="hidden" name="id" value={l.id} />
            <div className="row">
              <label className="field">Status
                <select name="status" defaultValue={status}>
                  {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_LABELS[s]}</option>)}
                </select>
              </label>
              <label className="field">Follow up on <input type="date" name="follow_up_at" defaultValue={l.follow_up_at ?? ""} /></label>
            </div>
            <div className="row">
              <label className="field">Customer name <input name="customer_name" maxLength={100} defaultValue={l.customer_name ?? ""} /></label>
              <label className="field">Service / project type <input name="project_type" required maxLength={200} defaultValue={l.project_type} /></label>
            </div>
            <label className="field">Description <textarea name="description" required rows={4} maxLength={1500} defaultValue={l.description} /></label>
            <div className="row">
              <label className="field">Budget <input name="budget" maxLength={100} defaultValue={l.budget ?? ""} /></label>
              <label className="field">Timeline <input name="timeline" maxLength={100} defaultValue={l.timeline ?? ""} /></label>
            </div>
            <label className="field">Requirements <textarea name="requirements" rows={5} maxLength={6000} defaultValue={requirementLines(reqs ?? [])} placeholder={"platform: Shopify\npayments: card"} /></label>
            <label className="field">Internal notes <textarea name="notes" rows={4} maxLength={4000} defaultValue={l.internal_notes ?? ""} /></label>
            <div><ChangeAwareSubmit pendingText="Saving...">Save lead</ChangeAwareSubmit></div>
          </form>
        </Card>
      </div>

        </div>
        <div className="rec-col">
      <Card title="Project brief" description="A plain-text summary you can paste into a proposal or send to a teammate. It does not include your internal notes."
        actions={<span className="row"><CopyButton text={brief} label="Copy brief" /><a className="btn btn-secondary btn-sm" href={`/dashboard/leads/${l.id}/brief`}>Download .txt</a></span>}>
        <pre className="brief">{brief}</pre>
      </Card>

        </div>
      </div>
    </>
  );
}
