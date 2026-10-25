import type { Metadata } from "next";
import LegalPage from "../../components/LegalPage";
import { COMPANY_NAME, PRODUCT_NAME, contactEmail } from "../../lib/brand";

export const metadata: Metadata = { title: "Terms of Service" };
export const dynamic = "force-dynamic";

export default function Terms() {
  const email = contactEmail();
  return (
    <LegalPage title="Terms of Service">
      <p>These terms apply when a business (&ldquo;you&rdquo;) uses {PRODUCT_NAME}, provided by {COMPANY_NAME} (&ldquo;we&rdquo;). By creating an account or connecting WhatsApp you agree to them.</p>

      <h2>The service</h2>
      <p>We provide an AI assistant that replies to your customers on your WhatsApp Business number using the information you give us, plus a dashboard to manage conversations, contacts, bookings and your knowledge base. Access may be limited or approved in stages.</p>

      <h2>Your account</h2>
      <ul>
        <li>Give accurate details and keep your password private. You are responsible for activity under your account.</li>
        <li>Only connect a WhatsApp number and Meta account that you are entitled to use.</li>
      </ul>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Follow the <a href="https://www.whatsapp.com/legal/business-policy" target="_blank" rel="noopener noreferrer">WhatsApp Business Policy</a> and Meta&apos;s terms, and all laws that apply to your messaging.</li>
        <li>Have a lawful basis, and any required consent, to message your customers, and tell them that an automated assistant may reply.</li>
        <li>Keep your knowledge base accurate and lawful. Do not upload content you have no right to use.</li>
        <li>Do not use the service for spam, harassment, fraud, illegal or harmful content, or to send material the customer has not asked for.</li>
      </ul>

      <h2>AI replies</h2>
      <p>Replies are written by an AI model from your knowledge base and may sometimes be incomplete or wrong. You can take over any conversation at any time and you are responsible for how you rely on the assistant. Do not use it for advice where a mistake could cause serious harm, such as medical, legal or financial decisions, without human review.</p>

      <h2>Third-party services</h2>
      <p>The service depends on Meta&apos;s WhatsApp Business Platform and other providers. Meta&apos;s own fees (such as conversation charges), limits and rules apply to your WhatsApp account, and we do not control them. We are not responsible for outages or changes at those providers.</p>

      <h2>Your data</h2>
      <p>You keep ownership of your content and your customers&apos; data. You allow us to process it only to provide the service, as described in our <a href="/privacy">Privacy Policy</a>.</p>

      <h2>Fees</h2>
      <p>Pricing, if any, will be agreed with you before it applies. Charges from Meta or other providers are separate.</p>

      <h2>Suspension and ending</h2>
      <p>You can stop using the service and ask us to delete your account at any time. We may suspend or end access if you break these terms or the rules of WhatsApp, or if needed to protect the service or other users.</p>

      <h2>Availability and liability</h2>
      <p>We work to keep the service running but provide it &ldquo;as is&rdquo;, without a guarantee that it is uninterrupted or error-free. To the extent the law allows, we are not liable for indirect or consequential loss, or loss of profit or business, and our total liability is limited to the amount you paid us in the three months before the claim.</p>

      <h2>Changes and contact</h2>
      <p>We may update these terms and will post the new version here with a new date. Continued use means you accept them.{email ? <> Questions: <a href={`mailto:${email}`}>{email}</a>.</> : ""}</p>
    </LegalPage>
  );
}
