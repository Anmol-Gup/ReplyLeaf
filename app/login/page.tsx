import Link from "next/link";
import Logo from "../../components/Logo";
import SubmitButton from "../../components/SubmitButton";
import { Alert } from "../../components/ui";
import { COMPANY_NAME } from "../../lib/brand";
import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
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
        {error && <div style={{ marginBottom: 16 }}><Alert kind="error">Email or password is incorrect. Please try again.</Alert></div>}
        <form action={login} className="stack">
          <label className="field">Email<input name="email" type="email" required autoComplete="username" autoFocus /></label>
          <label className="field">Password<input name="password" type="password" required autoComplete="current-password" /></label>
          <SubmitButton pendingText="Signing in...">Sign in</SubmitButton>
        </form>
        <p className="muted" style={{ marginTop: 18, textAlign: "center" }}><Link href="/">Back to home</Link></p>
      </div>
    </main>
  );
}
