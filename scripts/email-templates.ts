// Writes the branded "Confirm signup" email to supabase/templates/confirm-signup.html so you
// can paste it into the Supabase dashboard (Authentication > Emails > Templates) by hand.
// Or skip the pasting and use `npm run push-email-template`.
import { mkdirSync, writeFileSync } from "node:fs";
import { confirmSignupTemplate } from "../lib/email/html";

const { subject, html } = confirmSignupTemplate();
mkdirSync("supabase/templates", { recursive: true });
writeFileSync("supabase/templates/confirm-signup.html", html);
console.log(`Wrote supabase/templates/confirm-signup.html\nSubject to use: ${subject}`);
