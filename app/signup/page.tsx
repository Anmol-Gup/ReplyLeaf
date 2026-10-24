import Link from "next/link";
import { redirect } from "next/navigation";
import Logo from "../../components/Logo";
import SignupSentDialog from "../../components/SignupSentDialog";
import SubmitButton from "../../components/SubmitButton";
import { Alert } from "../../components/ui";
import { COMPANY_NAME, privacyUrl, termsUrl } from "../../lib/brand";
import { signupMode } from "../../lib/signup";
import { signUp } from "./actions";

const ERRORS: Record<string, string> = {
  invalid: "Please check your details and try again.",
  password: "Your password must be between 10 and 72 characters.",
  busy: "Too many attempts. Please wait a few minutes and try again.",
  failed: "We couldn't create your account. Please try again.",
};

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const mode = signupMode();
  if (mode === "off") redirect("/login");
  const { error, sent } = await searchParams;
  const privacy = privacyUrl();
  const terms = termsUrl();

  return (
    <main className="auth" id="main">
      {sent === "1" && <SignupSentDialog approval={mode === "approval"} />}
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Create your account</h1>
            <p className="muted">{COMPANY_NAME}</p>
          </div>
        </div>
        {mode === "approval" && (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="info">We are onboarding businesses in small groups. You can sign up now, and we will email you when your access is ready.</Alert>
          </div>
        )}
        {error && ERRORS[error] && <div style={{ marginBottom: 16 }}><Alert kind="error">{ERRORS[error]}</Alert></div>}
        <form action={signUp} className="stack">
          <label className="field">Business name<input name="business" required maxLength={100} autoComplete="organization" /></label>
          <label className="field">Email<input name="email" type="email" required maxLength={200} autoComplete="username" /></label>
          <label className="field">Password <span className="hint">At least 10 characters</span>
            <input name="password" type="password" required minLength={10} maxLength={72} autoComplete="new-password" />
          </label>
          {/* Honeypot: invisible to people and screen readers; bots fill it in. */}
          <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", height: 0, overflow: "hidden" }}>
            <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
          </div>
          <SubmitButton pendingText="Creating account...">Create account</SubmitButton>
        </form>
        <p className="muted" style={{ marginTop: 14, textAlign: "center" }}>
          By creating an account you agree to the{" "}
          {terms ? <a href={terms} target="_blank" rel="noopener noreferrer">Terms</a> : "Terms"} and{" "}
          {privacy ? <a href={privacy} target="_blank" rel="noopener noreferrer">Privacy Policy</a> : "Privacy Policy"}.
        </p>
        <p className="muted" style={{ marginTop: 10, textAlign: "center" }}>Already have an account? <Link href="/login">Sign in</Link></p>
      </div>
    </main>
  );
}
