import Link from "next/link";
import Logo from "../../components/Logo";
import PasswordField from "../../components/PasswordField";
import SubmitButton from "../../components/SubmitButton";
import { Alert } from "../../components/ui";
import { COMPANY_NAME } from "../../lib/brand";
import { safeNext } from "../../lib/auth-links";
import { signupMode } from "../../lib/signup";
import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const target = safeNext(next);
  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Sign in</h1>
            <p className="muted">{COMPANY_NAME}</p>
          </div>
        </div>
        {error === "unverified" ? (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="warn">Please verify your email first. Open the link we sent you, or <Link href="/verified?error=expired">request a new one</Link>.</Alert>
          </div>
        ) : error && <div style={{ marginBottom: 16 }}><Alert kind="error">Email or password is incorrect. Please try again.</Alert></div>}
        <form action={login} className="stack">
          {target && <input type="hidden" name="next" value={target} />}
          <label className="field">Email<input name="email" type="email" required autoComplete="username" autoFocus /></label>
          <PasswordField autoComplete="current-password" />
          <SubmitButton pendingText="Signing in...">Sign in</SubmitButton>
        </form>
        <p className="muted" style={{ marginTop: 18, textAlign: "center" }}>
          {signupMode() !== "off" && <>New here? <Link href="/signup">Create an account</Link> · </>}
          <Link href="/">Back to home</Link>
        </p>
      </div>
    </main>
  );
}
