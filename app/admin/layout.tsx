import Link from "next/link";
import Logo from "../../components/Logo";
import SubmitButton from "../../components/SubmitButton";
import { requireAdmin } from "../../lib/auth/session";
import { COMPANY_NAME } from "../../lib/brand";
import { logout } from "../dashboard/actions";

// Platform admin area. 404 for everyone who is not an admin (see requireAdmin).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="main" style={{ minHeight: "100vh" }}>
      <header className="topbar">
        <div className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
          <Logo size={32} />
          <span className="who">{COMPANY_NAME} · Admin</span>
        </div>
        <div className="row">
          <Link className="btn btn-ghost btn-sm" href="/dashboard">Dashboard</Link>
          <form action={logout}><SubmitButton variant="secondary" small pendingText="Signing out...">Sign out</SubmitButton></form>
        </div>
      </header>
      <main id="main" className="content">{children}</main>
    </div>
  );
}
