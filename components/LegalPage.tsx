import Link from "next/link";
import Logo from "./Logo";
import { COMPANY_NAME } from "../lib/brand";

export const LEGAL_UPDATED = "25 October 2026";

export default function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link href="/" className="row" style={{ gap: 10, fontWeight: 700 }}><Logo size={36} /> {COMPANY_NAME}</Link>
        <Link className="btn btn-secondary btn-sm" href="/login">Sign in</Link>
      </header>
      <main id="main" className="legal">
        <h1>{title}</h1>
        <p className="muted">Last updated {LEGAL_UPDATED}</p>
        {children}
      </main>
    </div>
  );
}
