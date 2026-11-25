"use client";

import Link from "next/link";
import { useActionState } from "react";
import PasswordField from "../../components/PasswordField";
import SubmitButton from "../../components/SubmitButton";
import { Alert } from "../../components/ui";
import { login, type LoginState } from "./actions";

// The sign-in form. A failed attempt comes back as state (not a redirect), so the page is not
// reloaded and the email stays filled in. The password is cleared on purpose.
export default function LoginForm({ next, initialError, reset }: { next: string | null; initialError: string | null; reset?: boolean }) {
  const [state, action] = useActionState<LoginState, FormData>(login, { error: initialError, email: "" });
  return (
    <>
      {reset && !state.error && <div style={{ marginBottom: 16 }}><Alert kind="ok">Your password has been changed. Sign in with the new one.</Alert></div>}
      {state.error === "unverified" ? (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warn">Please verify your email first. Open the link we sent you, or <Link href="/verified?error=expired">request a new one</Link>.</Alert>
        </div>
      ) : state.error && <div style={{ marginBottom: 16 }}><Alert kind="error">Email or password is incorrect. Please try again.</Alert></div>}
      <form action={action} className="stack">
        {next && <input type="hidden" name="next" value={next} />}
        <label className="field">Email<input name="email" type="email" required autoComplete="username" autoFocus defaultValue={state.email} key={state.email} /></label>
        <PasswordField autoComplete="current-password" />
        <p style={{ margin: "-6px 0 0", textAlign: "right" }}><Link href="/forgot-password">Forgot password?</Link></p>
        <SubmitButton pendingText="Signing in...">Sign in</SubmitButton>
      </form>
    </>
  );
}
