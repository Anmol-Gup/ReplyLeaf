import type { Metadata } from "next";
import LegalPage from "../../components/LegalPage";
import { LEGAL_NAME, PRODUCT_NAME, supportEmail } from "../../lib/brand";

export const metadata: Metadata = { title: "Privacy Policy" };
export const dynamic = "force-dynamic";

export default function Privacy() {
  const email = supportEmail();
  return (
    <LegalPage title="Privacy Policy">
      <p>{LEGAL_NAME} (&ldquo;we&rdquo;) provides {PRODUCT_NAME}, a service that lets a business answer its customers&apos; WhatsApp messages with an AI assistant. This policy explains what data we handle and why.</p>

      <h2>Who is responsible for what</h2>
      <p>The business that uses the service (&ldquo;the business&rdquo;) decides why its customers&apos; messages are handled and is responsible for telling its customers about it. We process that data on the business&apos;s behalf, only to run the service. For the account details of business owners who sign up with us, we are responsible for the data.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Business owners:</strong> name or business name, email address, password (stored only as a secure hash by our login provider), and the business information and documents you add to the knowledge base.</li>
        <li><strong>WhatsApp access:</strong> the identifiers of the connected WhatsApp account and number, and an access token that lets us send and receive messages for that business. Tokens are stored encrypted and are never shown in the dashboard.</li>
        <li><strong>The business&apos;s customers:</strong> phone number, WhatsApp profile name, message content and times, and details the customer shares in chat (such as a name or email).</li>
        <li><strong>Usage:</strong> anonymous counts such as the number of AI tokens used, for limits and billing.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To receive customer messages, write replies from the business&apos;s own knowledge base, and send them.</li>
        <li>To show the business its conversations and contacts, and to email the owner about leads and conversations that need a person.</li>
        <li>To send a customer updates about their own appointment or support request, by WhatsApp, or by email if they chose to share an address for that purpose.</li>
        <li>To keep the service secure, prevent abuse and fix faults.</li>
      </ul>
      <p>We do not sell personal data, and we do not use customer messages to train AI models.</p>

      <h2>Who else handles the data</h2>
      <p>We use these providers to run the service, and they process data only for that purpose:</p>
      <ul>
        <li><strong>Meta (WhatsApp Business Platform):</strong> carries the messages.</li>
        <li><strong>An AI provider (Google Gemini or OpenAI):</strong> receives the relevant customer message, recent conversation and knowledge-base excerpts to write a reply.</li>
        <li><strong>Supabase:</strong> database and login.</li>
        <li><strong>Vercel:</strong> hosting.</li>
        <li><strong>Gmail (SMTP):</strong> sends notification emails.</li>
      </ul>
      <p>These providers may process data outside your country. We do not share data with anyone else except where the law requires it.</p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Message content is erased after 12 months (we keep only counts).</li>
        <li>Logged unanswered questions are deleted after 12 months.</li>
        <li>When a business leaves, its WhatsApp token is erased immediately and its customer data is deleted 12 months later.</li>
        <li>Internal error logs are deleted after 90 days, and backups are kept for up to 90 days.</li>
      </ul>

      <h2>Your choices and rights</h2>
      <p>A business owner can delete any customer&apos;s data from that contact&apos;s page in the dashboard. A customer who wants their data deleted or a copy of it should ask the business they messaged; the business can action it in the dashboard{email ? ", or you can write to us" : ""}. Business owners can ask us to close their account and delete their data at any time.</p>

      <h2>Security</h2>
      <p>Access is controlled per business, so one business cannot see another&apos;s data. WhatsApp tokens are encrypted, connections use HTTPS, and webhook messages are verified before we trust them. No system is perfectly secure, and we will tell affected businesses if we find a breach that affects their data.</p>

      <h2>Children</h2>
      <p>The service is for businesses and is not directed at children.</p>

      <h2>Changes and contact</h2>
      <p>We will post changes on this page and update the date above.{email ? <> Questions or requests: <a href={`mailto:${email}`}>{email}</a>.</> : " For questions or requests, contact the team that gave you access to the service."}</p>
    </LegalPage>
  );
}
