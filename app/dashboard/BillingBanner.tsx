import Link from "next/link";
import { Alert } from "../../components/ui";
import { daysLeft, type Access } from "../../lib/billing/access";

// The persistent banner on every dashboard page. The billing page itself stays reachable in every state.
export default function BillingBanner({ access, now = new Date() }: { access: Access; now?: Date }) {
  if (access.banner === "none") return null;
  if (access.banner === "past_due_grace") {
    const n = daysLeft(access.graceEndsAt, now);
    return (
      <Alert kind="warn">
        <b>Your latest payment failed.</b> Please update your payment method within {n} day{n === 1 ? "" : "s"} to avoid interruption. <Link href="/dashboard/billing">Fix payment</Link>
      </Alert>
    );
  }
  if (access.banner === "cancel_scheduled") {
    return (
      <Alert kind="info">
        Your subscription is cancelled and ends on {access.paidThrough?.toISOString().slice(0, 10)}. <Link href="/dashboard/billing">Manage billing</Link>
      </Alert>
    );
  }
  return (
    <Alert kind="error">
      <b>Your subscription is inactive.</b> Renew your subscription to resume WhatsApp automation. You can still view and export your data. <Link href="/dashboard/billing">Renew now</Link>
    </Alert>
  );
}
