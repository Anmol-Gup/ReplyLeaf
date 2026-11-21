import Link from "next/link";
import { Avatar } from "./ConversationList";
import { Badge } from "./ui";

// The contact a ticket, lead or appointment belongs to, with a way to their record and chat.
export default function CustomerCard({ contact, conversationId, fallback }: {
  contact: { id: string; name: string | null; phone: string; email: string | null; status: string | null } | null;
  conversationId?: string | null;
  fallback: { name: string | null; phone: string };
}) {
  const name = contact?.name ?? fallback.name;
  const phone = contact?.phone ?? fallback.phone;
  return (
    <section className="card">
      <div className="rec-body">
        <div className="who-cell">
          <Avatar name={name || "?"} phone={!name} />
          <div style={{ minWidth: 0 }}>
            <b>{name || "Unnamed contact"}</b>
            <span className="muted">+{phone}{contact?.email ? ` · ${contact.email}` : ""}</span>
          </div>
          {contact?.status && <Badge tone="success">{contact.status}</Badge>}
        </div>
        <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
          {contact && <Link href={`/dashboard/contacts/${contact.id}`}>View contact</Link>}
          {contact && conversationId && " · "}
          {conversationId && <Link href={`/dashboard/conversations/${conversationId}`}>Open conversation</Link>}
        </p>
      </div>
    </section>
  );
}
