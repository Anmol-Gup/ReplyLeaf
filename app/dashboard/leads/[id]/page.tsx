import { editNote } from "../../note-actions";
import ActivityList, { type ActivityItem } from "../../../../components/ActivityList";
import Icon, { type IconName } from "../../../../components/Icon";
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
import { shortName } from "../../../../lib/notifications";
import { fmt } from "../../../../lib/dashboard";
import { LEAD_LABELS, LEAD_STATUSES, LEAD_TONES, projectBrief, requirementLines, type LeadStatus } from "../../../../lib/leads";
import Notice from "../../Notice";
import { addLeadNote, deleteLead, updateLeadDetails } from "../actions";

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
  const notesRes = await db.from("lead_notes").select("id, author_label, body, created_at").eq("lead_id", id).order("created_at", { ascending: false }).limit(200);
  const noteRows = (notesRes.error ? [] : notesRes.data ?? []) as { id: string; author_label: string | null; body: string; created_at: string }[]; // a database without migration 0029 simply shows none
  // What the record itself tells us (there is no separate history for leads).
  const feed: ActivityItem[] = [
    ...(l.updated_at && new Date(l.updated_at).getTime() - new Date(l.created_at).getTime() > 2000 ? [{ key: "updated", kind: "update", icon: "check" as IconName, title: `Status: ${LEAD_LABELS[status]}`, detail: l.follow_up_at ? `Follow up on ${l.follow_up_at}` : "Last changed", at: l.updated_at as string }] : []),
    { key: "created", kind: "update", icon: "zap" as IconName, title: "Enquiry received", detail: l.project_type as string, at: l.created_at as string },
    ...noteRows.map((n): ActivityItem => ({ key: `n-${n.id}`, kind: "note", noteId: n.id, icon: "chat", title: "Note", detail: n.body, at: n.created_at, meta: shortName(n.author_label) || "A team member" })),
    ...(l.internal_notes ? [{ key: "n-earlier", kind: "note", icon: "chat" as IconName, title: "Note", detail: l.internal_notes as string, at: "", meta: "Earlier note (written before notes were dated)" }] : []),
  ].sort((x, y) => (y.at || "").localeCompare(x.at || ""));
  const brief = projectBrief(l, reqs ?? [], clientName);

  return (
    <>
      <Link href="/dashboard/leads" className="rec-back"><Icon name="back" size={14} /> All leads</Link>
      <PageHeader
        title={l.customer_name || "Project enquiry"}
        description={`+${l.customer_phone}${emailOf ? ` · ${emailOf}` : ""} · received ${fmt(l.created_at)}`}
        actions={<span className="row"><ConfirmForm action={deleteLead} message="Delete this lead permanently? This cannot be undone."><input type="hidden" name="id" value={l.id} /><SubmitButton variant="danger" small pendingText="Deleting...">Delete</SubmitButton></ConfirmForm></span>}
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
        <Card title="Edit lead" description="Everything about this lead in one place. The follow-up date stays private and is never sent to the customer. Add notes in Activities. Put one requirement per line as  name: value  (for example  platform: Shopify).">
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
            <div><ChangeAwareSubmit pendingText="Saving...">Save lead</ChangeAwareSubmit></div>
          </form>
        </Card>
      </div>

        </div>
        <div className="rec-col">
      <section className="card">
        <h2 className="rec-title">Activities</h2>
        <div className="rec-body"><ActivityList items={feed} noteAction={addLeadNote} editAction={editNote} noteKind="lead" recordId={l.id} kinds={[{ id: "note", label: "Notes" }, { id: "update", label: "Updates" }]} /></div>
      </section>
      <Card title="Project brief" description="A plain-text summary you can paste into a proposal or send to a teammate. It does not include your internal notes."
        actions={<span className="row"><CopyButton text={brief} label="Copy brief" /><a className="btn btn-secondary btn-sm" href={`/dashboard/leads/${l.id}/brief`}>Download .txt</a></span>}>
        <pre className="brief">{brief}</pre>
      </Card>

        </div>
      </div>
    </>
  );
}
