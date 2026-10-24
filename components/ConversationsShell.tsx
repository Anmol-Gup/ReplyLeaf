"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Two panes on desktop. On a phone only one shows at a time: the list on
// /dashboard/conversations, the chat on /dashboard/conversations/<id>.
export function ConversationsShell({ list, children }: { list: React.ReactNode; children: React.ReactNode }) {
  const detail = usePathname() !== "/dashboard/conversations";
  return (
    <div className={`conv${detail ? " is-detail" : ""}`}>
      {list}
      <div>{children}</div>
    </div>
  );
}

export function ConversationLink({ id, children }: { id: string; children: React.ReactNode }) {
  const href = `/dashboard/conversations/${id}`;
  return (
    <Link href={href} className="conv-item" aria-current={usePathname() === href ? "page" : undefined}>
      {children}
    </Link>
  );
}
