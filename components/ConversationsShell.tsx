"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ConversationLink({ id, children }: { id: string; children: React.ReactNode }) {
  const href = `/dashboard/conversations/${id}`;
  return (
    <Link href={href} className="conv-item" aria-current={usePathname() === href ? "page" : undefined}>
      {children}
    </Link>
  );
}
