import Link from "next/link";
import Logo from "../../components/Logo";
import { PRODUCT_NAME } from "../../lib/brand";
import { safeNext } from "../../lib/auth-links";
import { signupMode } from "../../lib/signup";
import LoginForm from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
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
        <LoginForm next={target} initialError={error ?? null} />
        <p className="muted" style={{ marginTop: 18, textAlign: "center" }}>
          {signupMode() !== "off" && <>New here? <Link href="/signup">Create an account</Link> · </>}
          <Link href="/">Back to home</Link>
        </p>
      </div>
    </main>
  );
}
