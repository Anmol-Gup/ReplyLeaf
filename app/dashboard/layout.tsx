import DashboardShell from "../../components/DashboardShell";
import { requireClient } from "../../lib/auth/session";
import { logout } from "./actions";

// Every page under /dashboard is behind requireClient(): verified session + membership.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { clientName, user } = await requireClient();
  return <DashboardShell businessName={clientName} signOut={logout} isAdmin={user.app_metadata?.is_admin === true}>{children}</DashboardShell>;
}
