import Link from "next/link";
import Icon from "../../components/Icon";
import Logo from "../../components/Logo";
import SubmitButton from "../../components/SubmitButton";
import { PRODUCT_NAME } from "../../lib/brand";
import { signupMode } from "../../lib/signup";
import { resendVerification } from "./actions";

// The result of clicking the verification link: success, a bad or expired link, or "sent again".
// It carries no privileges. It only shows a message, so anyone may open it.
export default async function Verified({ searchParams }: { searchParams: Promise<{ error?: string; resent?: string }> }) {
  const { error, resent } = await searchParams;
  const approval = signupMode() === "approval";

  let view: React.ReactNode;
  if (resent === "1") {
    view = (
      <div className="empty">
        <span className="empty-icon"><Icon name="check" size={22} /></span>
        <h1 style={{ fontSize: "1.25rem" }}>Check your email</h1>
        <p className="muted">If that address belongs to an account that still needs verifying, we&apos;ve sent a new link. Check your spam folder too.</p>
        <Link className="btn btn-primary" href="/login">Back to sign in</Link>
      </div>
    );
  } else if (error) {
    view = (
      <div className="stack">
        <div className="empty">
          <span className="empty-icon danger"><Icon name="alert" size={22} /></span>
          <h1 style={{ fontSize: "1.25rem" }}>{error === "server" ? "We couldn't verify right now" : error === "expired" ? "This link has expired or was already used" : "This link isn't valid"}</h1>
          <p className="muted">
            {error === "server"
              ? "Something went wrong on our side or with the connection. Please try the link again in a minute, or"
              : error === "expired"
                ? "Verification links only work for a limited time, and only once. If you already verified, just sign in. Otherwise"
                : "It may have been copied incorrectly. If you already verified, just sign in. Otherwise"}{" "}
            enter your email and we&apos;ll send you a new one.
          </p>
        </div>
        <form action={resendVerification} className="stack">
          <label className="field">Email<input name="email" type="email" required maxLength={200} autoComplete="username" /></label>
          <SubmitButton pendingText="Sending...">Send a new link</SubmitButton>
        </form>
        <p className="muted" style={{ textAlign: "center" }}>Already verified? <Link href="/login">Sign in</Link></p>
      </div>
    );
  } else {
    view = (
      <div className="empty">
        <span className="empty-icon"><Icon name="check" size={22} /></span>
        <h1 style={{ fontSize: "1.25rem" }}>Your email has been verified successfully.</h1>
        <p className="muted">Thanks! You can sign in now.{approval ? " We'll review your account and email you when your access is approved." : ""}</p>
        <Link className="btn btn-primary" href="/login">Sign in</Link>
      </div>
    );
  }

  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="auth-brand"><Logo size={48} /><p className="muted">{PRODUCT_NAME}</p></div>
        {view}
      </div>
    </main>
  );
}
