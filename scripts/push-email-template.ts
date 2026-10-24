// Installs the branded "Confirm signup" email on your hosted Supabase project through
// Supabase's Management API. It changes ONLY the confirmation email's subject and body;
// every other auth setting is left alone.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... npm run push-email-template
//
// Create the token at supabase.com/dashboard/account/tokens (a personal access token; a
// fine-grained one needs auth_config_write and project_admin_write). It is only used by this
// command. Never put it in the app's environment on Vercel.
import { confirmSignupTemplate } from "../lib/email/html";

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!token) throw new Error("Set SUPABASE_ACCESS_TOKEN (create one at supabase.com/dashboard/account/tokens)");
  const ref = url ? new URL(url).hostname.split(".")[0] : "";
  if (!ref) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set, so the project ref is unknown");

  const { subject, html } = confirmSignupTemplate();
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mailer_subjects_confirmation: subject, mailer_templates_confirmation_content: html }),
  });
  if (!res.ok) throw new Error(`Supabase refused the update (${res.status}). Check the token and its permissions.`);
  console.log(`Installed the branded confirmation email on project ${ref}.\nSubject: ${subject}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
