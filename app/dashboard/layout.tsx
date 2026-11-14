import DashboardShell from "../../components/DashboardShell";
import { requireClient } from "../../lib/auth/session";
import { loadAccess } from "../../lib/billing/gate";
import BillingBanner from "./BillingBanner";
import { logout } from "./actions";

// Every page under /dashboard is behind requireClient(): verified session + membership.
// The billing banner reads OUR database (kept in step with Stripe); it never calls Stripe on a page view.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { clientId, clientName, user } = await requireClient();
  const access = await loadAccess(clientId);
  return (
    <DashboardShell businessName={clientName} signOut={logout} isAdmin={user.app_metadata?.is_admin === true}>
      <BillingBanner access={access} />
      {children}
    </DashboardShell>
  );
}
