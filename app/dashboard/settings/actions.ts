"use server";

import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
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
    updated_at: new Date().toISOString(),
  }, { onConflict: "client_id" });
  if (error) return back("invalid");
  if (primary) await db.from("clients").update({ owner_email: primary }).eq("id", clientId); // keep the older alert address in step
  return back("saved");
}
