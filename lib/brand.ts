// Company branding and the legal links shown on the landing page.
export const COMPANY_NAME = "AG Enterprises and Technologies";
export const PRODUCT_NAME = "WhatsApp AI Assistant";

// Legal links. They default to this app's own /privacy and /terms pages; set the public env vars to
// point at your own hosted pages instead (for example the ones registered with Meta).
export const privacyUrl = () => process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL || "/privacy";
export const termsUrl = () => process.env.NEXT_PUBLIC_TERMS_URL || "/terms";
// Optional public contact address shown on the legal pages.
export const contactEmail = () => process.env.NEXT_PUBLIC_CONTACT_EMAIL || null;
