import Link from "next/link";
import { requireClient } from "../../lib/auth/session";
import { logout } from "./actions";

// Every page under /dashboard is behind requireClient(): verified session + membership.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { clientName } = await requireClient();
  return (
    <div className="shell">
      <header className="topbar">
        <strong>{clientName}</strong>
        <nav>
          <Link href="/dashboard">Overview</Link>
          <Link href="/dashboard/conversations">Conversations</Link>
          <Link href="/dashboard/contacts">Contacts</Link>
          <Link href="/dashboard/bookings">Bookings</Link>
          <Link href="/dashboard/knowledge">Knowledge base</Link>
          <Link href="/dashboard/settings">Settings</Link>
          <Link href="/dashboard/usage">Usage</Link>
        </nav>
        <form action={logout}><button className="secondary" type="submit">Sign out</button></form>
      </header>
      {children}
    </div>
  );
}
