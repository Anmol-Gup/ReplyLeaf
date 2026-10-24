import Link from "next/link";
import { notFound } from "next/navigation";
import ChatLog from "../../../../components/ChatLog";
import Icon from "../../../../components/Icon";
import SubmitButton from "../../../../components/SubmitButton";
import { Alert, Badge, EmptyState } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { fmtDay, fmtTime, windowStatus } from "../../../../lib/dashboard";
import { WINDOW_CLOSED_WARNING } from "../../../../lib/whatsapp/window";
import Notice from "../../Notice";
import { handBack, sendHumanMessage, takeOver } from "../../actions";

export default async function ConversationPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();

  const { data: conv } = await db.from("conversations")
    .select("id, contact_id, handling, last_customer_message_at").eq("id", id).maybeSingle();
  if (!conv) notFound(); // also what another business's id looks like: RLS returns nothing
  const [{ data: contact }, { data: messages }] = await Promise.all([
    db.from("contacts").select("id, name, phone").eq("id", conv.contact_id).single(),
    db.from("messages").select("id, direction, sender, type, body, status, error, created_at")
      .eq("conversation_id", id).order("created_at", { ascending: false }).limit(200),
  ]);
  const chat = [...(messages ?? [])].reverse();
  const human = conv.handling === "human_active";
  const w = windowStatus(conv.last_customer_message_at);
  const canReply = human && w.open;

  return (
    <section className="chat-panel" aria-label="Conversation">
      <div className="chat-head">
        <div className="spread">
          <div className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <Link href="/dashboard/conversations" className="btn btn-ghost btn-sm back-link" aria-label="Back to all conversations">
              <Icon name="back" />
            </Link>
            <div style={{ minWidth: 0 }}>
              <h1>{contact?.name || "Unknown"}</h1>
              <p className="muted">+{contact?.phone} · <Link href={`/dashboard/contacts/${contact?.id}`}>Contact details</Link></p>
            </div>
          </div>
          {human ? (
            <form action={handBack}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton variant="secondary" pendingText="Handing back...">Hand back to bot</SubmitButton>
            </form>
          ) : (
            <form action={takeOver}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton pendingText="Taking over...">Take over</SubmitButton>
            </form>
          )}
        </div>
        <div className="row">
          {human ? <Badge tone="warn">You are handling this chat. The assistant is silent.</Badge> : <Badge tone="brand">The assistant is handling this chat</Badge>}
          <span className="window"><span className={`dot${w.open ? " on" : ""}`} aria-hidden="true" /> <span><b>24-hour window:</b> {w.label}</span></span>
        </div>
        <Notice code={notice} />
      </div>

      <ChatLog>
        {chat.length === 0 && <EmptyState icon="chat" title="No messages yet" />}
        {chat.map((m, i) => {
          const showDay = i === 0 || fmtDay(chat[i - 1].created_at) !== fmtDay(m.created_at);
          const flag = m.status === "blocked" ? "Not sent: 24-hour window closed" : m.status === "failed" ? "Not sent: failed" : null;
          return (
            <div key={m.id} style={{ display: "contents" }}>
              {showDay && <span className="day">{fmtDay(m.created_at)}</span>}
              <div className={`bubble ${m.sender}${flag ? " failed" : ""}`}>
                {m.sender !== "customer" && <span className="tag">{m.sender === "bot" ? "Assistant" : "You"}</span>}
                {m.body ?? (m.type !== "text" ? `[${m.type} message]` : "[deleted by retention policy]")}
                {flag && <span className="flag">{flag}</span>}
                <time dateTime={m.created_at}>{fmtTime(m.created_at)} UTC</time>
              </div>
            </div>
          );
        })}
      </ChatLog>

      <div className="reply">
        {!w.open && <div style={{ marginBottom: 12 }}><Alert kind="warn">{WINDOW_CLOSED_WARNING}</Alert></div>}
        {!human && w.open && <p className="muted" style={{ marginBottom: 10 }}>Take over the conversation to reply yourself.</p>}
        <form action={sendHumanMessage} className="stack-sm">
          <input type="hidden" name="id" value={id} />
          <label className="sr-only" htmlFor="reply-text">Your message</label>
          <textarea id="reply-text" name="text" maxLength={1500} required disabled={!canReply} placeholder={canReply ? "Type your message" : human ? "The 24-hour window is closed" : "Take over to reply"} style={{ minHeight: 80 }} />
          <div><SubmitButton disabled={!canReply} pendingText="Sending..."><Icon name="send" size={16} /> Send on WhatsApp</SubmitButton></div>
        </form>
      </div>
    </section>
  );
}
