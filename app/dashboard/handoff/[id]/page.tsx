import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "../../../../components/ConversationList";
import SubmitButton from "../../../../components/SubmitButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { clip, fmt, fmtTime, windowStatus } from "../../../../lib/dashboard";
import { SOURCE_LABELS, type HandoffSource } from "../../../../lib/handoff";
import { ago } from "../../../../lib/notifications";
import { listTeam } from "../../../../lib/team";
import Notice from "../../Notice";
import { assignHandoff, queueResolve, queueResumeAi, queueTakeOver } from "../actions";

// One handoff: who, why, the AI's summary, the latest messages, who has it, and the actions. The chat itself lives in Conversations.
export default async function HandoffDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, user, clientId } = await requireClient();
  const { data: h } = await db.from("handoff_requests")
    .select("id, conversation_id, source, reason, ai_summary, status, assigned_user_id, created_at, resolved_at").eq("id", id).maybeSingle();
  if (!h) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: conv }, { data: recent }, team] = await Promise.all([
    db.from("conversations").select("contact_id, last_customer_message_at").eq("id", h.conversation_id).maybeSingle(),
    db.from("messages").select("id, sender, direction, body, type, created_at").eq("conversation_id", h.conversation_id).order("created_at", { ascending: false }).limit(8),
    listTeam(clientId),
  ]);
  const { data: contact } = conv ? await db.from("contacts").select("id, name, phone").eq("id", conv.contact_id).maybeSingle() : { data: null };
  const messages = [...(recent ?? [])].reverse();
  const open = h.status !== "resolved";
  const owner = team.find((m) => m.id === h.assigned_user_id)?.label ?? (h.assigned_user_id ? "Former team member" : null);
  const mine = h.assigned_user_id === user.id;
  const canAct = open && (!h.assigned_user_id || mine);
  const w = windowStatus(conv?.last_customer_message_at as string | null | undefined);
  const here = `/dashboard/handoff/${id}`;
  const conversationHref = `/dashboard/conversations/${h.conversation_id}`;
  const hidden = (<><input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} /></>);

  return (
    <>
      <PageHeader
        title={contact?.name || `+${contact?.phone ?? ""}`}
        description={`Handoff requested ${fmt(h.created_at)}${open ? ` · waiting ${ago(h.created_at).replace(" ago", "")}` : ""}`}
        actions={<span className="row"><Link className="btn btn-primary btn-sm" href={conversationHref}>Open conversation</Link><Link className="btn btn-ghost btn-sm" href="/dashboard/handoff">All handoffs</Link></span>}
      />
      <Notice code={notice} />
      <div className="hdetail">
        <div className="stack">
          <Card title="Why this needs a person" actions={<Badge tone={!open ? "success" : owner ? "brand" : "warn"}>{!open ? "Resolved" : owner ? "Assigned" : "Waiting for human"}</Badge>}>
            <dl className="handoff-facts">
              <div><dt>Reason</dt><dd>{h.reason ?? SOURCE_LABELS[h.source as HandoffSource]}</dd></div>
              <div><dt>AI summary</dt><dd>{h.ai_summary || "-"}</dd></div>
            </dl>
          </Card>
          <Card title="Recent messages">
            {messages.length === 0 ? <p className="muted">No messages yet.</p> : (
              <ul className="recent-msgs">
                {messages.map((m) => (
                  <li key={m.id} className={m.sender === "customer" ? "from-customer" : "from-us"}>
                    <b>{m.sender === "customer" ? contact?.name || "Customer" : m.sender === "human" ? "Team" : "Assistant"}</b>
                    <span>{m.body ? clip(m.body, 240) : `[${m.type} message]`}</span>
                    <small className="muted">{fmtTime(m.created_at)} UTC</small>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="Customer">
            <div className="who-cell"><Avatar name={contact?.name || "?"} phone={!contact?.name} />
              <div><b>{contact?.name || "Not given"}</b><span className="muted">+{contact?.phone}</span></div></div>
            <p className="muted" style={{ marginTop: 10 }}>
              <Link href={`/dashboard/contacts/${contact?.id}`}>Contact details</Link>
            </p>
            <dl className="handoff-facts" style={{ marginTop: 10 }}>
              <div><dt>Assigned to</dt><dd>{owner ? (mine ? "You" : owner) : "Nobody yet"}</dd></div>
              <div><dt>Created</dt><dd>{fmt(h.created_at)}</dd></div>
              {!open && <div><dt>Resolved</dt><dd>{fmt(h.resolved_at)}</dd></div>}
              <div><dt>WhatsApp 24-hour window</dt><dd><span className="window"><span className={`dot${w.open ? " on" : ""}`} aria-hidden="true" /> {w.label}</span></dd></div>
            </dl>
          </Card>
          {open && (
            <Card title="Actions">
              <div className="stack-sm">
                {canAct && <form action={queueTakeOver}>{hidden}<SubmitButton pendingText="Taking over...">Take over</SubmitButton></form>}
                <form action={assignHandoff} className="stack-sm">
                  {hidden}
                  <label className="field">Assign to team member
                    <select name="assignee" defaultValue={h.assigned_user_id ?? ""}>
                      <option value="">Unassigned</option>
                      {team.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === user.id ? " (you)" : ""}</option>)}
                    </select>
                  </label>
                  <div><SubmitButton small variant="secondary" pendingText="Saving...">Save assignment</SubmitButton></div>
                </form>
                {canAct && (
                  <div className="row">
                    <form action={queueResolve}>{hidden}<SubmitButton small variant="secondary" pendingText="Saving...">Mark resolved</SubmitButton></form>
                    <form action={queueResumeAi}>{hidden}<SubmitButton small variant="secondary" pendingText="Resuming...">Resume assistant</SubmitButton></form>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
