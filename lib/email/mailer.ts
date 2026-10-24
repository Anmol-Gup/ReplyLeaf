import nodemailer, { type Transporter } from "nodemailer";

// Email goes through this tiny interface so the provider can be swapped later
// (Resend, SES, ...) by writing another implementation and changing getMailer().
// `html` is optional; when present the email is sent as multipart with `text` as the plain-text version.
export type MailMessage = { to: string; subject: string; text: string; html?: string };

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

// Header values must be one line, or a customer-controlled string could inject headers.
export const oneLine = (s: string, max = 150) => s.replace(/[\r\n]+/g, " ").trim().slice(0, max);

let cached: Mailer | null | undefined;

/** Gmail SMTP with an app password. Returns null when email isn't configured. */
export function getMailer(source: Record<string, string | undefined> = process.env): Mailer | null {
  if (cached !== undefined && source === process.env) return cached;
  const user = source.GMAIL_USER;
  const pass = source.GMAIL_APP_PASSWORD;
  const mailer = user && pass ? gmailMailer(user, pass, source.MAIL_FROM || user) : null;
  if (source === process.env) cached = mailer;
  return mailer;
}

function gmailMailer(user: string, pass: string, from: string): Mailer {
  let transport: Transporter | undefined;
  return {
    async send(msg) {
      transport ??= nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
      });
      await transport.sendMail({ from, to: msg.to, subject: oneLine(msg.subject), text: msg.text, html: msg.html });
    },
  };
}
