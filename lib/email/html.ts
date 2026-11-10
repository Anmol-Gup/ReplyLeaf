import { LEGAL_NAME, PRODUCT_NAME } from "../brand";

// One branded HTML layout for the sign-up emails. Written the way email clients
// need: tables, inline styles, no external CSS or images (many clients block those),
// and a plain-text twin is always sent alongside. Every piece of dynamic text is
// escaped, so a business name like "<script>" can never become markup.

const BRAND = "#087b55"; // Replyleaf green; the button adds a gradient on top (bgcolor stays as the fallback)
const BRAND_GRADIENT = "linear-gradient(135deg,#0a8159 0%,#087b55 55%,#066a48 100%)";
const INK = "#10241a";
const BODY = "#34463d";
const MUTED = "#455a4f";
const LINE = "#dbe4df";
const BG = "#f4f7f5";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export type EmailContent = {
  /** Hidden preview text shown next to the subject in inboxes. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** A name/value table, e.g. who signed up. */
  details?: { label: string; value: string }[];
  button?: { label: string; url: string };
  footer?: string;
};

export function emailLayout(c: EmailContent): string {
  const paragraphs = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BODY};">${escapeHtml(p)}</p>`)
    .join("");

  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;">${c.details
        .map((d, i) => `<tr><td style="padding:10px 14px;width:34%;font-size:13px;color:${MUTED};${i ? `border-top:1px solid ${LINE};` : ""}">${escapeHtml(d.label)}</td><td style="padding:10px 14px;font-size:14px;font-weight:600;color:${INK};${i ? `border-top:1px solid ${LINE};` : ""}">${escapeHtml(d.value)}</td></tr>`)
        .join("")}</table>`
    : "";

  const url = c.button ? escapeHtml(c.button.url) : "";
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr><td align="center" bgcolor="${BRAND}" style="border-radius:9px;background:${BRAND_GRADIENT};"><a href="${url}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px;">${escapeHtml(c.button.label)}</a></td></tr></table>
       <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${MUTED};">If the button doesn&#39;t work, copy and paste this link into your browser:</p>
       <p style="margin:0 0 8px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${url}" target="_blank" style="color:${BRAND};">${url}</a></p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(c.heading)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(c.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};"><tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};">
    <tr><td style="padding:0 4px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${BRAND}" width="36" height="36" align="center" style="border-radius:9px;background:${BRAND_GRADIENT};font-size:14px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">R</td>
        <td style="padding-left:10px;font-size:15px;font-weight:700;color:${INK};">${escapeHtml(PRODUCT_NAME)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;padding:32px 30px;">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK};letter-spacing:-0.01em;">${escapeHtml(c.heading)}</h1>
      ${paragraphs}${details}${button}
      ${c.footer ? `<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid ${LINE};font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(c.footer)}</p>` : ""}
    </td></tr>
    <tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:${MUTED};text-align:center;">&copy; ${new Date().getFullYear()} ${escapeHtml(LEGAL_NAME)}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/**
 * The "Confirm signup" email that SUPABASE sends (it is not sent by this app).
 * Built from the same layout so all emails look alike. {{ ... }} are Supabase's own
 * template placeholders and are filled in by Supabase when it sends the email.
 */
export function confirmSignupTemplate(): { subject: string; html: string } {
  return {
    subject: `Confirm your email address - ${PRODUCT_NAME}`,
    html: emailLayout({
      preheader: "One quick step to finish creating your account.",
      heading: "Confirm your email address",
      paragraphs: [
        "Thanks for signing up. Please confirm that {{ .Email }} is your email address to finish creating your account.",
      ],
      // Through our own /auth/confirm page (token_hash flow): verified on the server, only when the
      // person presses the button there. Needs Supabase's Site URL to be this app's URL.
      button: { label: "Confirm my email", url: "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email" },
      footer: "If you didn't create an account, you can safely ignore this email. The link only works once.",
    }),
  };
}
