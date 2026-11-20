import Link from "next/link";
import { notFound } from "next/navigation";
import ChatLog from "../../../../components/ChatLog";
import ChangeAwareSubmit from "../../../../components/ChangeAwareSubmit";
import CopyButton from "../../../../components/CopyButton";
import SubmitButton from "../../../../components/SubmitButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { fmt, fmtDay, fmtTime } from "../../../../lib/dashboard";
import { LEAD_LABELS, LEAD_STATUSES, LEAD_TONES, projectBrief, requirementLines, type LeadStatus } from "../../../../lib/leads";
import Notice from "../../Notice";
import { updateLeadDetails } from "../actions";

export default async function LeadDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, clientName } = await requireClient();
  const { data: l } = await db.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: reqs }, { data: contact }, { data: messages }] = await Promise.all([
    db.from("lead_requirements").select("requirement_key, requirement_value").eq("lead_id", id).order("created_at"),
    db.from("contacts").select("id, name, email").eq("id", l.contact_id).maybeSingle(),
    db.from("messages").select("id, sender, type, body, status, created_at").eq("conversation_id", l.conversation_id)
      .order("created_at", { ascending: false }).limit(100),
  ]);
  const chat = [...(messages ?? [])].reverse();
  const status = l.status as LeadStatus;
  const brief = projectBrief(l, reqs ?? [], clientName);

  return (
    <>
      <PageHeader
        title={l.customer_name || "Project enquiry"}
        description={`+${l.customer_phone}${contact?.email ? ` · ${contact.email}` : ""} · received ${fmt(l.created_at)}`}
        actions={<span className="row"><a className="btn btn-primary btn-sm" href="#edit">Edit details</a><Link className="btn btn-secondary btn-sm" href="/dashboard/leads">All leads</Link></span>}
      />
      <Notice code={notice} />
      <Card title={l.project_type} actions={<Badge tone={LEAD_TONES[status]}>{LEAD_LABELS[status]}</Badge>}>
        <dl className="handoff-facts">
          <div><dt>AI summary</dt><dd>{l.ai_summary || "-"}</dd></div>
          <div><dt>Description</dt><dd>{l.description}</dd></div>
          <div><dt>Budget</dt><dd>{l.budget ?? "Not given"}</dd></div>
          <div><dt>Timeline</dt><dd>{l.timeline ?? "Not given"}</dd></div>
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href={`/dashboard/conversations/${l.conversation_id}`}>Open the conversation</Link>
          {contact && <> · <Link href={`/dashboard/contacts/${contact.id}`}>Contact details</Link></>}
        </p>
      </Card>

      <Card title="Requirements" description="Collected from the conversation, as the customer described them.">
        {(reqs ?? []).length === 0 ? <p className="muted">No extra details were collected.</p> : (
          <dl className="handoff-facts">
            {(reqs ?? []).map((r, i) => <div key={i}><dt>{r.requirement_key}</dt><dd>{r.requirement_value}</dd></div>)}
          </dl>
        )}
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

      <Card title="Project brief" description="A plain-text summary you can paste into a proposal or send to a teammate. It does not include your internal notes."
        actions={<span className="row"><CopyButton text={brief} label="Copy brief" /><a className="btn btn-secondary btn-sm" href={`/dashboard/leads/${l.id}/brief`}>Download .txt</a></span>}>
        <pre className="brief">{brief}</pre>
      </Card>

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
