import Link from "next/link";
import Icon, { type IconName } from "../components/Icon";
import Logo from "../components/Logo";
import { PRODUCT_NAME, LEGAL_NAME, privacyUrl, supportEmail, termsUrl } from "../lib/brand";
import { signupMode } from "../lib/signup";

// Reads SIGNUP_MODE, so it must be rendered per request, not frozen at build time.
export const dynamic = "force-dynamic";

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: "book", title: "Answers from your own knowledge", text: "Replies only from the information you provide. If the answer isn't there, it says it will check with your team." },
  { icon: "calendar", title: "Shares your booking link", text: "When a customer wants to book, it sends your booking link. No link set? A team member takes over the chat." },
  { icon: "users", title: "You stay in control", text: "Take over any chat in one click, hand it back when you're done, and keep every customer in your contact list." },
];

const CHAT: { from: "customer" | "assistant"; text: string; time: string }[] = [
  { from: "customer", text: "Hi! What time do you open on Saturdays?", time: "10:02" },
  { from: "assistant", text: "Hello! On Saturdays we're open from 9am to 2pm. Is there anything else I can help with?", time: "10:02" },
  { from: "customer", text: "Great. Can I book a haircut for this Saturday?", time: "10:03" },
  { from: "assistant", text: "Of course! You can choose a time that suits you here: book.example.com/riya-salon", time: "10:03" },
];

// Hidden entirely when the URL is not configured.
function LegalLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : null;
}

export default function Home() {
  const privacy = privacyUrl();
  const terms = termsUrl();
  const support = supportEmail();
  return (
    <div className="landing chat-bg">
      <header className="landing-nav">
        <span className="row" style={{ gap: 10, fontWeight: 700 }}><Logo size={36} /> {PRODUCT_NAME}</span>
        <Link className="btn btn-secondary btn-sm" href="/login">Sign in</Link>
      </header>

      <main id="main">
        <section className="hero hero-split">
          <div className="hero-copy">
            <p className="hero-eyebrow"><Logo size={28} /> {PRODUCT_NAME}</p>
            <h1>An AI assistant on WhatsApp that answers customer questions and shares your booking link</h1>
            <p className="hero-lead">Customers get an instant, friendly answer from your own information, and you keep control of every conversation.</p>
            <div className="row hero-actions">
              <Link className="btn btn-primary" href="/login">Sign in</Link>
              {signupMode() !== "off" && <Link className="btn btn-secondary" href="/signup">Create account</Link>}
            </div>
            <p className="hero-note">Works through WhatsApp in plain text only: replies arrive as ordinary text messages, with nothing for your customers to install.</p>
          </div>

          <figure className="card sample-chat">
            <figcaption className="sample-chat-head">
              <span className="sample-chat-title">Example conversation</span>
              <span className="muted">Sample only</span>
            </figcaption>
            <ol className="sample-log" aria-label="Example conversation between a customer and the assistant">
              {CHAT.map((m, i) => (
                <li key={i} className={`sample-msg ${m.from === "customer" ? "sample-in" : "sample-out"}`}>
                  <span className="sr-only">{m.from === "customer" ? "Customer: " : "Assistant: "}</span>
                  {m.text}
                  <span className="sample-time" aria-hidden="true">{m.time}</span>
                </li>
              ))}
            </ol>
          </figure>
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
          <div className="footer-about">
            <span>&copy; {new Date().getFullYear()} {LEGAL_NAME}</span>
            {support && <span>Support: <a href={`mailto:${support}`}>{support}</a></span>}
          </div>
          {(privacy || terms) && (
            <nav aria-label="Legal">
              <LegalLink href={privacy}>Privacy Policy</LegalLink>
              <LegalLink href={terms}>Terms</LegalLink>
            </nav>
          )}
        </div>
      </footer>
    </div>
  );
}
