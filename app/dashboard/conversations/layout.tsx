import { ConversationLink, ConversationsShell } from "../../../components/ConversationsShell";
import { Badge, EmptyState, ErrorState, PageHeader } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmtDay, fmtTime, windowStatus } from "../../../lib/dashboard";
import AutoRefresh from "../AutoRefresh";

// Left pane: the conversation list (needs-you first). The right pane is the page.
export default async function ConversationsLayout({ children }: { children: React.ReactNode }) {
  const { db } = await requireClient();
  const { data: convs, error } = await db.from("conversations")
    .select("id, contact_id, handling, last_customer_message_at, updated_at")
    .order("updated_at", { ascending: false }).limit(100);

  const ids = (convs ?? []).map((c) => c.id);
  const [{ data: contacts }, { data: recent }] = ids.length
    ? await Promise.all([
        db.from("contacts").select("id, name, phone").in("id", (convs ?? []).map((c) => c.contact_id)),
        db.from("messages").select("conversation_id, direction, sender, body, type, created_at")
          .in("conversation_id", ids).order("created_at", { ascending: false }).limit(400),
      ])
    : [{ data: [] }, { data: [] }];

  const byContact = new Map((contacts ?? []).map((c) => [c.id, c]));
  const lastByConv = new Map<string, { direction: string; sender: string; body: string | null; type: string; created_at: string }>();
  for (const m of recent ?? []) if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
  const rows = [...(convs ?? [])].sort((a, b) => Number(b.handling === "human_active") - Number(a.handling === "human_active"));

  const list = (
    <aside className="conv-list" aria-label="Conversations">
      <h2>Conversations</h2>
      {error ? <ErrorState>The conversation list could not be loaded.</ErrorState>
        : rows.length === 0 ? <EmptyState icon="chat" title="No conversations yet">They appear here when customers message your WhatsApp number.</EmptyState>
        : (
          <div className="conv-items">
            {rows.map((c) => {
              const contact = byContact.get(c.contact_id);
              const last = lastByConv.get(c.id);
              const w = windowStatus(c.last_customer_message_at);
              const preview = last ? (last.body ? clip(last.body, 60) : `[${last.type} message]`) : "";
              return (
                <ConversationLink key={c.id} id={c.id}>
                  <div className="top">
                    <span className="name">{contact?.name || `+${contact?.phone}`}</span>
                    <small className="muted">{last ? `${fmtDay(last.created_at)} ${fmtTime(last.created_at)}` : ""}</small>
                  </div>
                  <div className="preview">{last?.direction === "outbound" ? (last.sender === "human" ? "You: " : "Assistant: ") : ""}{preview}</div>
                  <div className="meta">
                    {c.handling === "human_active" ? <Badge tone="warn">Needs you</Badge> : <Badge tone="brand">Assistant</Badge>}
                    {!w.open && <Badge>Window closed</Badge>}
                  </div>
                </ConversationLink>
              );
            })}
          </div>
        )}
    </aside>
  );

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Conversations" description="Chats with your customers. Take over any chat to reply yourself." />
      <ConversationsShell list={list}>{children}</ConversationsShell>
    </>
  );
}
