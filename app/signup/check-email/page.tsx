import Link from "next/link";
import Icon from "../../../components/Icon";
import { signupMode } from "../../../lib/signup";

// Reads SIGNUP_MODE, so it must be rendered per request, not frozen at build time.
export const dynamic = "force-dynamic";

// The same message whether the address is new or already registered.
export default function CheckEmail() {
  const approval = signupMode() === "approval";
  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="empty">
          <span className="empty-icon"><Icon name="check" size={22} /></span>
          <h1 style={{ fontSize: "1.25rem" }}>Check your email</h1>
          <p className="muted">
            If the address can be used, we sent a confirmation link. Confirm your email, then sign in.
            {approval ? " We'll let you know once your access is approved." : ""}
          </p>
          <Link className="btn btn-primary" href="/login">Go to sign in</Link>
        </div>
      </div>
    </main>
  );
}
