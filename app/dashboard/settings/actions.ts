"use server";

import { redirect } from "next/navigation";
import { checkKeyFormat, KEY_PROVIDERS, lastFour, type KeyProvider } from "../../../lib/ai-keys";
import { verifyKey } from "../../../lib/ai-key-verify";
import { requireClient } from "../../../lib/auth/session";
import { encryptSecret } from "../../../lib/crypto";
import { env } from "../../../lib/env";
import { parseEmails, parseOneEmail } from "../../../lib/notify-settings";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { formToWorkflowInput, workflowSettingsSchema } from "../../../lib/workflow-settings";

// Same security model as the other dashboard actions: requireClient() gives the clientId, writes use the
// service role and are always matched on that client_id. Nothing secret is read or written here.
const back = (notice: string): never => redirect(`/dashboard/settings?notice=${notice}`);
const field = (fd: FormData, n: string) => { const v = fd.get(n); return typeof v === "string" ? v : null; };

export async function updateWorkflows(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = workflowSettingsSchema.safeParse(formToWorkflowInput((n) => field(formData, n)));
  if (!parsed.success) return back("invalid");
  await supabaseAdmin().from("clients").update({ workflow_settings: parsed.data }).eq("id", clientId);
  return back("saved");
}

export async function updateNotifications(formData: FormData) {
  const { clientId } = await requireClient();
  const primaryRaw = (field(formData, "primary_email") ?? "").trim();
  const primary = primaryRaw ? parseOneEmail(primaryRaw) : null;
  if (primaryRaw && !primary) return back("notif_invalid");
  const extra = parseEmails(field(formData, "additional_emails") ?? "");
  if (extra.invalid.length > 0 || extra.tooMany) return back("notif_invalid");

  const db = supabaseAdmin();
  const { error } = await db.from("notification_settings").upsert({
    client_id: clientId, primary_email: primary, additional_emails: extra.emails,
    appointment_notifications: formData.get("appointment_notifications") !== null,
    lead_notifications: formData.get("lead_notifications") !== null,
    handoff_notifications: formData.get("handoff_notifications") !== null,
    ticket_notifications: formData.get("ticket_notifications") !== null,
    delivery: field(formData, "delivery") === "immediate" ? "immediate" : "daily",
    updated_at: new Date().toISOString(),
  }, { onConflict: "client_id" });
  if (error) return back("invalid");
  if (primary) await db.from("clients").update({ owner_email: primary }).eq("id", clientId); // keep the older alert address in step
  return back("saved");
}

// ------------------------------------------------------------------ AI key (bring your own)
// SECURITY: the key is read from the form, checked with the provider, encrypted (AES-256-GCM) and stored in
// client_secrets, which owners cannot read. It is never logged, echoed back or put in a redirect. Only a status
// and the last four characters are kept where the page can show them.
const isProvider = (v: unknown): v is KeyProvider => (KEY_PROVIDERS as readonly unknown[]).includes(v);

export async function saveAiKey(formData: FormData) {
  const { clientId } = await requireClient();
  const provider = field(formData, "ai_provider");
  if (!isProvider(provider)) return back("invalid");
  const checked = checkKeyFormat(provider, field(formData, "ai_key"));
  if (!checked.ok) return back(checked.reason === "empty" ? "ai_key_empty" : "ai_key_format");

  const status = await verifyKey(provider, checked.key);
  if (status === "invalid") return back("ai_key_refused"); // not stored

  const db = supabaseAdmin();
  const { error: secretErr } = await db.from("client_secrets").upsert(
    { client_id: clientId, ai_api_key_enc: encryptSecret(checked.key, env().ENCRYPTION_KEY) }, { onConflict: "client_id" });
  if (secretErr) return back("invalid");
  await db.from("clients").update({
    ai_mode: "byok", ai_provider: provider, ai_key_status: status, ai_key_last4: lastFour(checked.key),
    ai_key_checked_at: new Date().toISOString(), ai_key_notified_at: null,
  }).eq("id", clientId);

  // Chats that were handed over only because the key was missing or refused go back to the assistant.
  const { data: paused } = await db.from("handoff_requests").select("id")
    .eq("client_id", clientId).eq("source", "ai_unavailable").neq("status", "resolved").limit(200);
  for (const h of paused ?? []) {
    await db.rpc("set_handoff_status", { p_client_id: clientId, p_handoff_id: h.id, p_action: "resume_ai", p_assignee: null });
  }
  return back(status === "valid" ? "ai_key_saved" : "ai_key_saved_unverified");
}

export async function removeAiKey() {
  const { clientId } = await requireClient();
  const db = supabaseAdmin();
  await db.from("client_secrets").update({ ai_api_key_enc: null }).eq("client_id", clientId);
  await db.from("clients").update({ ai_key_status: "none", ai_key_last4: null, ai_key_checked_at: null })
    .eq("id", clientId).eq("ai_mode", "byok");
  return back("ai_key_removed");
}

/** Only for businesses on the platform's AI (an admin granted it): choose Gemini or OpenAI. */
export async function setPlatformProvider(formData: FormData) {
  const { clientId } = await requireClient();
  const provider = field(formData, "ai_provider");
  if (!isProvider(provider)) return back("invalid");
  await supabaseAdmin().from("clients").update({ ai_provider: provider }).eq("id", clientId).eq("ai_mode", "platform");
  return back("saved");
}
