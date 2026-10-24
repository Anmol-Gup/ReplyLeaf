import Link from "next/link";
import Icon, { type IconName } from "../components/Icon";
import Logo from "../components/Logo";
import { COMPANY_NAME, privacyUrl, termsUrl } from "../lib/brand";
import { signupMode } from "../lib/signup";

// Reads SIGNUP_MODE, so it must be rendered per request, not frozen at build time.
export const dynamic = "force-dynamic";

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: "book", title: "Answers from your own knowledge", text: "Replies only from the information you provide. If the answer isn't there, it says it will check with your team." },
  { icon: "calendar", title: "Takes booking requests", text: "Shares your booking link, or collects the service, time and name and emails you the request to confirm." },
  { icon: "users", title: "You stay in control", text: "Take over any chat in one click, hand it back when you're done, and keep every customer in your contact list." },
];

function LegalLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}

export default function Home() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="row" style={{ gap: 10, fontWeight: 700 }}><Logo size={36} /> {COMPANY_NAME}</span>
        <Link className="btn btn-secondary btn-sm" href="/login">Sign in</Link>
      </header>

      <main id="main">
        <section className="hero">
          <h1>An AI assistant on WhatsApp for your business</h1>
          <p>It answers your customers&apos; questions from your own information and takes booking requests, so you can focus on the work.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link className="btn btn-primary" href="/login">Business owners: sign in</Link>
            {signupMode() !== "off" && <Link className="btn btn-secondary" href="/signup">Create an account</Link>}
          </div>
        </section>

        <section className="features" aria-label="Features">
          {FEATURES.map((f) => (
            <article key={f.title} className="card feature">
              <span className="empty-icon"><Icon name={f.icon} size={22} /></span>
              <h2>{f.title}</h2>
              <p>{f.text}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>&copy; {new Date().getFullYear()} {COMPANY_NAME}</span>
          <nav aria-label="Legal">
            <LegalLink href={privacyUrl()}>Privacy Policy</LegalLink>
            <LegalLink href={termsUrl()}>Terms</LegalLink>
          </nav>
        </div>
      </footer>
    </div>
  );
}
