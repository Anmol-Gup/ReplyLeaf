import Link from "next/link";
import { redirect } from "next/navigation";
import Icon from "../../../components/Icon";
import Logo from "../../../components/Logo";
import { isEmailOtpType, isValidTokenHash } from "../../../lib/auth-links";
import { PRODUCT_NAME } from "../../../lib/brand";
import AutoConfirm from "./AutoConfirm";

// The landing page of the "Confirm my email" button in the verification email. It verifies automatically (see AutoConfirm).
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token_hash?: string; type?: string }> }) {
  const { token_hash, type } = await searchParams;
  if (!isValidTokenHash(token_hash) || !isEmailOtpType(type)) redirect("/verified?error=invalid");

  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="auth-brand"><Logo size={48} /><p className="muted">{PRODUCT_NAME}</p></div>
        <div className="empty">
          <span className="empty-icon"><Icon name="check" size={22} /></span>
          <h1 style={{ fontSize: "1.25rem" }}>Verifying your email</h1>
          <AutoConfirm tokenHash={token_hash} type={type} />
          {/* The link is single-use and this page cannot tell whether it was already used until it is submitted. */}
          <p className="muted">Already confirmed your email? <Link href="/login">Sign in</Link></p>
        </div>
      </div>
    </main>
  );
}
