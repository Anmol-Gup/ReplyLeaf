// Company branding and the legal links shown on the landing page.
export const COMPANY_NAME = "AG Enterprises and Technologies";
export const PRODUCT_NAME = "WhatsApp AI Assistant";

// Configurable links (public env vars). When unset the footer shows plain text, not a dead link.
export const privacyUrl = () => process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL || null;
export const termsUrl = () => process.env.NEXT_PUBLIC_TERMS_URL || null;
