import Link from "next/link";
import Icon, { type IconName } from "../components/Icon";
import Logo from "../components/Logo";
import ChatPreview from "../components/landing/ChatPreview";
import LandingMenu from "../components/landing/LandingMenu";
import { LEGAL_NAME, PRODUCT_NAME, privacyUrl, supportEmail, termsUrl } from "../lib/brand";
import { signupMode } from "../lib/signup";
import "./landing.css";

// Reads SIGNUP_MODE and the legal/support env vars, so it must be rendered per request, not frozen at build time.
export const dynamic = "force-dynamic";

// Every claim on this page describes something the app does today. Appointment collection and lead
// qualification are NOT built yet: do not add them here until they are.
const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#use-cases", label: "Use cases" },
];

const FEATURES: { icon: IconName; label: string; title: string; text: string }[] = [
  { icon: "book", label: "AI customer support", title: "Answers from your business knowledge", text: "Give customers instant answers using your own documents, FAQs and business information. If the answer isn't there, it says it will check with your team." },
  { icon: "users", label: "Customer contacts", title: "Never miss a potential customer", text: "Every new customer becomes a contact in your dashboard. Names and emails shared in chat are suggested for you to confirm, and you get an email for each new lead." },
  { icon: "calendar", label: "Bookings", title: "Send customers to your booking link", text: "When a customer wants to book, Replyleaf shares your booking link. No link set? Your team is alerted to take over the chat." },
  { icon: "shield", label: "Human handoff", title: "Stay in control of every conversation", text: "When a customer needs a person, the assistant steps aside and your team is emailed with a short summary of what they need. Take over, then hand the chat back when you're done." },
];

const STEPS = [
  { title: "Connect your WhatsApp Business account", text: "Sign in and connect your number through Meta's secure sign-up. It takes a few minutes." },
  { title: "Add your business information", text: "Upload documents or type in what customers ask about, then choose how the assistant should help." },
  { title: "Let Replyleaf handle the conversations", text: "It replies to customers, flags new leads for you, and hands over to your team when a person is needed." },
];

const USE_CASES = [
  { title: "Digital marketing agencies", text: "Answer questions about services and packages, and be alerted to new enquiries." },
  { title: "Clinics", text: "Share opening hours and service details, and point patients to your booking link." },
  { title: "Real estate businesses", text: "Answer questions from your listing information and hand serious buyers to an agent." },
  { title: "Coaching institutes", text: "Reply to course, schedule and fee questions from your own information." },
  { title: "E-commerce businesses", text: "Answer shipping, returns and product questions from your FAQ." },
  { title: "Professional service providers", text: "Handle first questions and pass client requests to the right person." },
];

const CONTROL_POINTS = [
  "See every conversation as it happens in your dashboard.",
  "Take over any chat in one click. The assistant goes quiet while you reply.",
  "Hand the chat back to the assistant when you're finished.",
  "Get an email for new leads and for chats that need a person, with a summary of what the customer wants.",
];

export default function Home() {
  const privacy = privacyUrl();
  const terms = termsUrl();
  const support = supportEmail();
  const open = signupMode() !== "off";
  const ctaHref = open ? "/signup" : "/login";
  const ctaLabel = "Get started";

  return (
    <div className="landing chat-bg lp">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <Link href="/" className="lp-brand" aria-label={`${PRODUCT_NAME} home`}><Logo size={34} /> {PRODUCT_NAME}</Link>
          <nav className="lp-links" aria-label="Main">
            {NAV_LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
          </nav>
          <div className="lp-nav-actions">
            <Link className="btn btn-secondary btn-sm lp-signin" href="/login">Sign in</Link>
            <Link className="btn btn-primary btn-sm" href={ctaHref}>{ctaLabel}</Link>
            <LandingMenu links={NAV_LINKS} signInHref="/login" ctaHref={ctaHref} ctaLabel={ctaLabel} />
          </div>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Your AI-powered WhatsApp assistant</p>
            <h1>Turn WhatsApp conversations into business growth.</h1>
            <p className="lp-lead">Replyleaf answers customer questions using your business knowledge, shares your booking link, and connects customers with your team whenever they need a person.</p>
            <div className="lp-actions">
              <Link className="btn btn-primary lp-btn-lg" href={ctaHref}>{ctaLabel}</Link>
              <a className="btn btn-secondary lp-btn-lg" href="#how-it-works">See how it works</a>
            </div>
            <p className="lp-fine">No complicated setup. Your customers continue chatting on WhatsApp, in plain text.</p>
          </div>
          <ChatPreview />
        </section>

        <section id="features" className="lp-section">
          <div className="lp-section-head">
            <h2>Everything your business needs to manage conversations.</h2>
          </div>
          <div className="lp-features">
            {FEATURES.map((f) => (
              <article key={f.title} className="lp-card">
                <span className="lp-icon"><Icon name={f.icon} size={22} /></span>
                <p className="lp-card-label">{f.label}</p>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="lp-section">
          <div className="lp-section-head">
            <p className="lp-eyebrow">How it works</p>
            <h2>Up and running in three steps.</h2>
          </div>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="lp-step">
                <span className="lp-step-num" aria-hidden="true">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="use-cases" className="lp-section">
          <div className="lp-section-head">
            <p className="lp-eyebrow">Use cases</p>
            <h2>Built for businesses that talk to customers all day.</h2>
            <p>Replies come only from the information you provide, so the assistant sticks to what your business knows.</p>
          </div>
          <ul className="lp-cases">
            {USE_CASES.map((u) => (
              <li key={u.title} className="lp-case">
                <h3>{u.title}</h3>
                <p>{u.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-section lp-control">
          <div className="lp-control-copy">
            <p className="lp-eyebrow">Human control</p>
            <h2>You&apos;re always in the loop.</h2>
            <p>Replyleaf helps your team, it doesn&apos;t replace it. Monitor conversations, review your contacts and step in whenever a customer needs you.</p>
          </div>
          <ul className="lp-checks">
            {CONTROL_POINTS.map((p) => (
              <li key={p}><span className="lp-check" aria-hidden="true"><Icon name="check" size={14} /></span>{p}</li>
            ))}
          </ul>
        </section>

        <section className="lp-cta" aria-labelledby="lp-cta-title">
          <h2 id="lp-cta-title">Your next customer could be one message away.</h2>
          <p>Give your customers faster answers and give your business more time to grow.</p>
          <Link className="btn lp-btn-light lp-btn-lg" href={ctaHref}>Get started with {PRODUCT_NAME}</Link>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <span className="lp-brand lp-brand-light"><Logo size={32} /> {PRODUCT_NAME}</span>
            <p>An AI assistant for your WhatsApp Business conversations.</p>
          </div>
          <nav aria-label="Product" className="lp-footer-col">
            <h2>Product</h2>
            {NAV_LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
          </nav>
          {(support || privacy || terms) && (
            <nav aria-label="Company" className="lp-footer-col">
              <h2>Company</h2>
              {support && <a href={`mailto:${support}`}>Contact</a>}
              {privacy && <a href={privacy} target="_blank" rel="noopener noreferrer">Privacy Policy</a>}
              {terms && <a href={terms} target="_blank" rel="noopener noreferrer">Terms of Service</a>}
            </nav>
          )}
        </div>
        <p className="lp-footer-legal">&copy; {new Date().getFullYear()} {LEGAL_NAME}</p>
      </footer>
    </div>
  );
}
