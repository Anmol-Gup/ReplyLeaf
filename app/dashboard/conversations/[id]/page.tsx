import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClient } from "../../../../lib/auth/session";
import { fmt } from "../../../../lib/dashboard";
import { WINDOW_CLOSED_WARNING, isWithinWindow } from "../../../../lib/whatsapp/window";
import AutoRefresh from "../../AutoRefresh";
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
  const windowOpen = isWithinWindow(conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null);

  return (
    <section className="card">
      <AutoRefresh />
      <p><Link href="/dashboard/conversations">&larr; All conversations</Link></p>
      <h1>{contact?.name || "Unknown"} <span className="muted">+{contact?.phone}</span></h1>
      <Notice code={notice} />
      <div className="row" style={{ marginBottom: 12 }}>
        <span className={`badge ${human ? "human" : "ok"}`}>{human ? "You are handling this chat; the assistant is silent" : "The assistant is handling this chat"}</span>
        {human
          ? <form action={handBack}><input type="hidden" name="id" value={id} /><button className="secondary" type="submit">Hand back to assistant</button></form>
          : <form action={takeOver}><input type="hidden" name="id" value={id} /><button type="submit">Take over</button></form>}
        <Link href={`/dashboard/contacts/${contact?.id}`}>Contact details</Link>
      </div>

      <div className="chat">
        {chat.map((m) => (
          <div key={m.id} className={`msg ${m.sender}`}>
            {m.body ?? (m.type !== "text" ? `[${m.type} message]` : "[deleted by retention policy]")}
            <small>
              {m.sender === "customer" ? "Customer" : m.sender === "bot" ? "Assistant" : "You"} · {fmt(m.created_at)}
              {m.status === "blocked" && " · NOT SENT: 24h window closed"}
              {m.status === "failed" && " · NOT SENT: failed"}
            </small>
          </div>
        ))}
      </div>

      <h2>Reply</h2>
      {!windowOpen && <p className="notice warn">{WINDOW_CLOSED_WARNING}</p>}
      {!human && <p className="muted">Take over the conversation to reply yourself.</p>}
      <form action={sendHumanMessage} className="stack">
        <input type="hidden" name="id" value={id} />
        <textarea name="text" maxLength={1500} required disabled={!human || !windowOpen} placeholder="Type your message" />
        <div><button type="submit" disabled={!human || !windowOpen}>Send on WhatsApp</button></div>
      </form>
    </section>
  );
}
