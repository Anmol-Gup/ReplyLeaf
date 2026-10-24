import { redirect } from "next/navigation";
import Icon from "../../components/Icon";
import Logo from "../../components/Logo";
import SubmitButton from "../../components/SubmitButton";
import { requireVerifiedUser, userIsApproved } from "../../lib/auth/session";
import { COMPANY_NAME } from "../../lib/brand";
import { notifyPendingSignup } from "../../lib/signup-notify";
import { logout } from "../dashboard/actions";

// Where unapproved sign-ups land. The moment they are approved, this page sends them on.
export default async function Pending() {
  const { user, token } = await requireVerifiedUser();
  if (await userIsApproved(user, token)) redirect("/dashboard");
  await notifyPendingSignup(user); // once: emails the user and the admin

  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="auth-brand"><Logo size={48} /><p className="muted">{COMPANY_NAME}</p></div>
        <div className="empty">
          <span className="empty-icon"><Icon name="info" size={22} /></span>
          <h1 style={{ fontSize: "1.25rem" }}>You&apos;re on the list</h1>
          <p className="muted">
            Thanks for signing up. We&apos;re onboarding businesses in small groups and will email {user.email} when your access is ready. We've also sent you a confirmation email.
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <a className="btn btn-secondary" href="/pending">Check again</a>
            <form action={logout}><SubmitButton variant="ghost" pendingText="Signing out...">Sign out</SubmitButton></form>
          </div>
        </div>
      </div>
    </main>
  );
}
