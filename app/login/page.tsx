import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrNull } from "../../lib/auth/session";
import Logo from "../../components/Logo";
import { PRODUCT_NAME } from "../../lib/brand";
import { safeNext } from "../../lib/auth-links";
import { signupMode } from "../../lib/signup";
import LoginForm from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string; reset?: string }> }) {
  // Already signed in (for example after pressing Back from the dashboard or onboarding): no sign-in form.
  const user = await getUserOrNull();
  if (user) redirect(user.app_metadata?.is_admin === true ? "/admin/signups" : "/dashboard");
  const { error, next, reset } = await searchParams;
  const target = safeNext(next);
  return (
    <main className="auth chat-bg" id="main">
      <div className="card">
        <div className="auth-brand">
          <Logo size={48} />
          <div>
            <h1>Sign in</h1>
            <p className="muted">{PRODUCT_NAME}</p>
          </div>
        </div>
        <LoginForm next={target} initialError={error ?? null} reset={reset === "1"} />
        <p className="muted" style={{ marginTop: 18, textAlign: "center" }}>
          {signupMode() !== "off" && <>New here? <Link href="/signup">Create an account</Link> · </>}
          <Link href="/">Back to home</Link>
        </p>
      </div>
    </main>
  );
}
