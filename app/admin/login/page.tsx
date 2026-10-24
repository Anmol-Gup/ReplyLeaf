import { redirect } from "next/navigation";
import Logo from "../../../components/Logo";
import PasswordField from "../../../components/PasswordField";
import SubmitButton from "../../../components/SubmitButton";
import { Alert } from "../../../components/ui";
import { getUserOrNull } from "../../../lib/auth/session";
import { safeNext } from "../../../lib/auth-links";
import { COMPANY_NAME } from "../../../lib/brand";
import { adminLogin } from "./actions";

const ERRORS: Record<string, string> = {
  invalid: "Email or password is incorrect.",
  notadmin: "This sign-in is for administrators only.",
};

// Administrator sign-in: no sign-up link and no link to the public site.
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const user = await getUserOrNull();
  if (user?.app_metadata?.is_admin === true) redirect("/admin/signups"); // already signed in

  const wanted = safeNext(next);
  const target = wanted?.startsWith("/admin") ? wanted : null;
  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Administrator sign in</h1>
            <p className="muted">{COMPANY_NAME}</p>
          </div>
        </div>
        {error && ERRORS[error] && <div style={{ marginBottom: 16 }}><Alert kind="error">{ERRORS[error]}</Alert></div>}
        <form action={adminLogin} className="stack">
          {target && <input type="hidden" name="next" value={target} />}
          <label className="field">Email<input name="email" type="email" required autoComplete="username" autoFocus /></label>
          <PasswordField autoComplete="current-password" />
          <SubmitButton pendingText="Signing in...">Sign in</SubmitButton>
        </form>
      </div>
    </main>
  );
}
