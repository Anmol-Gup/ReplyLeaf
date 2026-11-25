import Link from "next/link";
import Icon from "../../components/Icon";
import Logo from "../../components/Logo";
import SubmitButton from "../../components/SubmitButton";
import { PRODUCT_NAME } from "../../lib/brand";
import { requestPasswordReset } from "./actions";

export default async function ForgotPassword({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <main className="auth chat-bg" id="main">
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Forgot your password?</h1>
            <p className="muted">{PRODUCT_NAME}</p>
          </div>
        </div>
        {sent === "1" ? (
          <div className="empty">
            <span className="empty-icon"><Icon name="check" size={22} /></span>
            <h2 style={{ fontSize: "1.15rem" }}>Check your email</h2>
            <p className="muted">If that address belongs to an account, we&apos;ve sent a link to choose a new password. It works once and expires in about an hour. Check your spam folder too.</p>
            <Link className="btn btn-primary" href="/login">Back to sign in</Link>
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 16 }}>Enter your email and we&apos;ll send you a link to choose a new password.</p>
            <form action={requestPasswordReset} className="stack">
              <label className="field">Email<input name="email" type="email" required maxLength={200} autoComplete="username" autoFocus /></label>
              <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", height: 0, overflow: "hidden" }}>
                <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
              </div>
              <SubmitButton pendingText="Sending...">Send reset link</SubmitButton>
            </form>
            <p className="muted" style={{ marginTop: 18, textAlign: "center" }}><Link href="/login">Back to sign in</Link></p>
          </>
        )}
      </div>
    </main>
  );
}
