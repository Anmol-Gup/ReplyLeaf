import Link from "next/link";
import Icon from "../../components/Icon";
import Logo from "../../components/Logo";
import PasswordField from "../../components/PasswordField";
import SubmitButton from "../../components/SubmitButton";
import { Alert } from "../../components/ui";
import { isValidTokenHash } from "../../lib/auth-links";
import { PRODUCT_NAME } from "../../lib/brand";
import { resetPassword } from "./actions";

const FORM_ERRORS: Record<string, string> = {
  password: "Your password must be between 10 and 72 characters.",
  mismatch: "The two passwords don't match.",
  same: "Choose a password different from your current one.",
};

// The landing page of the link in the reset email. Opening it changes nothing; the link is only used when the form is submitted.
export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ token_hash?: string; error?: string }> }) {
  const { token_hash, error } = await searchParams;
  const usable = isValidTokenHash(token_hash);
  const dead = !usable || error === "invalid" || error === "expired" || error === "server";

  return (
    <main className="auth chat-bg" id="main">
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Choose a new password</h1>
            <p className="muted">{PRODUCT_NAME}</p>
          </div>
        </div>
        {dead ? (
          <div className="empty">
            <span className="empty-icon danger"><Icon name="alert" size={22} /></span>
            <h2 style={{ fontSize: "1.15rem" }}>{error === "server" ? "We couldn't reset it right now" : "This link has expired or was already used"}</h2>
            <p className="muted">{error === "server" ? "Something went wrong on our side. Please try again in a minute, or request a new link." : "Reset links work once and expire in about an hour. Request a new one."}</p>
            <Link className="btn btn-primary" href="/forgot-password">Send a new link</Link>
          </div>
        ) : (
          <>
            {error && FORM_ERRORS[error] && <div style={{ marginBottom: 16 }}><Alert kind="error">{FORM_ERRORS[error]}</Alert></div>}
            <form action={resetPassword} className="stack">
              <input type="hidden" name="token_hash" value={token_hash} />
              <PasswordField label="New password" autoComplete="new-password" hint="At least 10 characters" minLength={10} maxLength={72} />
              <PasswordField label="Confirm new password" name="confirm" autoComplete="new-password" minLength={10} maxLength={72} />
              <SubmitButton pendingText="Saving...">Change password</SubmitButton>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
