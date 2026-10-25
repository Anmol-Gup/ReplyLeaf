// Company branding and the legal links shown on the landing page.
export const COMPANY_NAME = "AG Enterprises and Technologies";
export const PRODUCT_NAME = "WhatsApp AI Assistant";

export const LEGAL_NAME = `${COMPANY_NAME} (OPC) Pvt. Ltd.`;

// Footer and sign-up links. Server-side env vars (read per request, so no rebuild is needed to change them).
// The older NEXT_PUBLIC_ names still work. When a URL is unset the link is hidden, not shown dead.
const clean = (v: string | undefined) => v?.trim() || null;
export const privacyUrl = () => clean(process.env.PRIVACY_POLICY_URL) ?? clean(process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL);
export const termsUrl = () => clean(process.env.TERMS_URL) ?? clean(process.env.NEXT_PUBLIC_TERMS_URL);
// Support address shown in the footer and on the legal pages. Hidden when unset.
export const supportEmail = () => clean(process.env.SUPPORT_EMAIL) ?? clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL);
