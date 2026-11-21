import Link from "next/link";
import { notFound } from "next/navigation";
import ChatLog from "../../../../components/ChatLog";
import Icon from "../../../../components/Icon";
import SubmitButton from "../../../../components/SubmitButton";
import { Alert, Badge, EmptyState } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { conversationActions, conversationStateOf, STATE_LABELS, STATE_TONES, type OpenHandoff } from "../../../../lib/conversation-state";
import { supabaseAdmin } from "../../../../lib/supabase-admin";
import { listTeam } from "../../../../lib/team";
import { fmt, fmtDay, fmtTime, windowStatus } from "../../../../lib/dashboard";
import { WINDOW_CLOSED_WARNING } from "../../../../lib/whatsapp/window";
import Notice from "../../Notice";
import { Avatar } from "../../../../components/ConversationList";
import { SOURCE_LABELS, type HandoffSource } from "../../../../lib/handoff";
import { assignHandoff } from "../../handoff/actions";
import { handBack, sendHumanMessage, takeOver } from "../../actions";

export default async function ConversationPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db, user, clientId } = await requireClient();

  const { data: conv } = await db.from("conversations")
    .select("id, contact_id, handling, last_customer_message_at").eq("id", id).maybeSingle();
  if (!conv) notFound(); // also what another business's id looks like: RLS returns nothing
  const [{ data: contact }, { data: messages }] = await Promise.all([
    db.from("contacts").select("id, name, phone").eq("id", conv.contact_id).single(),
    db.from("messages").select("id, direction, sender, type, body, status, error, created_at")
      .eq("conversation_id", id).order("created_at", { ascending: false }).limit(200),
  ]);
  const chat = [...(messages ?? [])].reverse();
  const [{ data: open }, team] = await Promise.all([
    db.from("handoff_requests").select("id, status, assigned_user_id, source, reason, ai_summary, created_at").eq("conversation_id", id).neq("status", "resolved").maybeSingle(),
    listTeam(clientId),
  ]);
  const state = conversationStateOf(conv.handling, open as OpenHandoff, user.id);
  const act = conversationActions(state);
  const w = windowStatus(conv.last_customer_message_at);
  const canReply = act.canReply && w.open;
  const ho = open as (OpenHandoff & { id: string; source: HandoffSource; reason: string | null; ai_summary: string | null; created_at: string }) | null;
  const handler = team.find((m) => m.id === (open as OpenHandoff)?.assigned_user_id)?.label ?? "another team member";
  const requestId = crypto.randomUUID(); // one per page view: a double click or retry of the same form cannot send twice
  // Opening the chat marks it read for this person (a database without migration 0026 simply skips it).
  try { await supabaseAdmin().from("conversation_reads").upsert({ conversation_id: id, client_id: clientId, user_id: user.id, read_at: new Date().toISOString() }); } catch { /* optional */ }

  return (
    <>
    <section className="chat-panel" aria-label="Conversation">
      <div className="chat-head">
        <div className="spread">
          <div className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <Link href="/dashboard/conversations" className="btn btn-ghost btn-sm back-link" aria-label="Back to all conversations">
              <Icon name="back" />
            </Link>
            <Avatar name={contact?.name || "?"} phone={!contact?.name} />
            <div style={{ minWidth: 0 }}>
              <h1>{contact?.name || "Unknown"}</h1>
              <p className="muted">+{contact?.phone} · <Link href={`/dashboard/contacts/${contact?.id}`}>Contact details</Link></p>
            </div>
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
          <Badge tone={STATE_TONES[state]}>{state === "other" ? `Assigned to ${handler}` : STATE_LABELS[state]}</Badge>
          {act.button === "resume_ai" && (
            <form action={handBack}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton variant="secondary" pendingText="Resuming...">Resume AI</SubmitButton>
            </form>
          )}
          {act.button === "take_over" && (
            <form action={takeOver}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton pendingText="Taking over...">Take over</SubmitButton>
            </form>
          )}
          </div>
        </div>
        <div className="row">
          <span className="window"><span className={`dot${w.open ? " on" : ""}`} aria-hidden="true" /> <span><b>24-hour window:</b> {w.label}</span></span>
        </div>
        <Notice code={notice} />
      </div>

      {ho && (
        <div className="handoff-banner">
          <b>Human handoff requested</b>
          <div className="cols">
            <div><small>Reason</small><p>{ho.reason ?? SOURCE_LABELS[ho.source]}</p></div>
            <div><small>AI summary</small><p>{ho.ai_summary || "-"}</p></div>
          </div>
        </div>
      )}
      <ChatLog>
        {chat.length === 0 && <EmptyState icon="chat" title="No messages yet" />}
        {chat.map((m, i) => {
          const showDay = i === 0 || fmtDay(chat[i - 1].created_at) !== fmtDay(m.created_at);
          const flag = m.status === "blocked" ? "Not sent: 24-hour window closed" : m.status === "failed" ? "Not sent: failed" : null;
          const delivery = m.direction === "outbound" && !flag ? (m.status === "sending" ? "Sending…" : m.status === "sent" ? "Sent" : m.status === "delivered" ? "Delivered" : m.status === "read" ? "Read" : null) : null;
          return (
            <div key={m.id} style={{ display: "contents" }}>
              {showDay && <span className="day">{fmtDay(m.created_at)}</span>}
              <div className={`bubble ${m.sender}${flag ? " failed" : ""}`}>
                {m.sender !== "customer" && <span className="tag">{m.sender === "bot" ? "Assistant" : "You"}</span>}
                {m.body ?? (m.type !== "text" ? `[${m.type} message]` : "[deleted by retention policy]")}
                {flag && <span className="flag">{flag}</span>}
                {delivery && <span className="muted"> · {delivery}</span>}
                <time dateTime={m.created_at}>{fmtTime(m.created_at)} UTC</time>
              </div>
            </div>
          );
        })}
      </ChatLog>

      <div className="reply">
        {state === "waiting" && <div className="lock-banner"><b>This conversation is waiting for a human response.</b><span>The assistant has paused and won&apos;t reply until you take over.</span></div>}
        {act.canReply && !w.open && <div style={{ marginBottom: 12 }}><Alert kind="warn">{WINDOW_CLOSED_WARNING}</Alert></div>}
        {!act.canReply && state !== "waiting" && <p className="muted" style={{ marginBottom: 10 }}>{state === "other" ? `${handler} is handling this conversation, so replying is turned off for you.` : "Take over the conversation to reply yourself. The assistant stays silent once you do."}</p>}
        <form action={sendHumanMessage} className="stack-sm">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="request_id" value={requestId} />
          <label className="sr-only" htmlFor="reply-text">Your message</label>
          <textarea id="reply-text" name="text" maxLength={1500} required disabled={!canReply} placeholder={canReply ? "Type your message" : act.canReply ? "The 24-hour window is closed" : "Take over to reply"} style={{ minHeight: 80 }} />
          <div><SubmitButton disabled={!canReply} pendingText="Sending..."><Icon name="send" size={16} /> Send on WhatsApp</SubmitButton></div>
        </form>
      </div>
    </section>
    <aside className="conv-details" aria-label="Conversation details">
      <div className="dcard">
        <h3>Customer</h3>
        <dl><div><dt>Name</dt><dd>{contact?.name || "Not given"}</dd></div><div><dt>Phone</dt><dd>+{contact?.phone}</dd></div></dl>
        <Link href={`/dashboard/contacts/${contact?.id}`}>Contact details →</Link>
      </div>
      {ho && (
        <div className="dcard dcard-warn">
          <h3>Handoff info</h3>
          <dl>
            <div><dt>Reason</dt><dd>{ho.reason ?? SOURCE_LABELS[ho.source]}</dd></div>
            <div><dt>AI summary</dt><dd>{ho.ai_summary || "-"}</dd></div>
            <div><dt>Requested at</dt><dd>{fmt(ho.created_at)}</dd></div>
            <div><dt>Status</dt><dd><Badge tone={STATE_TONES[state]}>{state === "other" ? `Assigned to ${handler}` : STATE_LABELS[state]}</Badge></dd></div>
          </dl>
        </div>
      )}
      {ho && (
        <div className="dcard">
          <h3>Assignment</h3>
          <form action={assignHandoff} className="stack-sm">
            <input type="hidden" name="id" value={ho.id} /><input type="hidden" name="back" value={`/dashboard/conversations/${id}`} />
            <label className="field">Assigned to
              <select name="assignee" defaultValue={ho.assigned_user_id ?? ""}>
                <option value="">Unassigned</option>
                {team.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === user.id ? " (you)" : ""}</option>)}
              </select>
            </label>
            <div><SubmitButton small variant="secondary" pendingText="Saving...">Save assignment</SubmitButton></div>
          </form>
        </div>
      )}
    </aside>
    </>
  );
}
