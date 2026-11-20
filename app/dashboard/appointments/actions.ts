"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePaidAccess } from "../../../lib/billing/gate";
import { requireClient } from "../../../lib/auth/session";
import { appointmentUpdateSchema, scheduleNotice, validateSchedule } from "../../../lib/appointments";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { parseWorkflowSettings } from "../../../lib/workflow-settings";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the signed-in owner's membership;
// writes use the service role and every query filters by that clientId. Form ids are never trusted on their own.
// Nothing here contacts the customer: the owner talks to them directly and records the outcome.

const detail = (id: string) => `/dashboard/appointments/${id}`;
const go = (id: string, notice: string): never => redirect(`${detail(id)}?notice=${notice}`);

export async function updateAppointment(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId);
  const rawId = String(formData.get("id") ?? "");
  const text = (n: string) => String(formData.get(n) ?? "");
  const parsed = appointmentUpdateSchema.safeParse({ id: formData.get("id"), status: formData.get("status"), scheduled_date: text("scheduled_date"), scheduled_time: text("scheduled_time"), customer_email: text("customer_email"), notes: text("notes") });
  if (!parsed.success) return z.string().uuid().safeParse(rawId).success ? go(rawId, "invalid") : redirect("/dashboard/appointments?notice=invalid");
  const v = parsed.data;

  const db = supabaseAdmin();
  const { data: before } = await db.from("appointments").select("id, status, scheduled_date, scheduled_time, timezone").eq("id", v.id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/appointments?notice=not_found");

  // A confirmed appointment must have the agreed date and a clock time. The date is checked against today only when it is new or
  // changed, so an old confirmed appointment can still be marked completed after its date has passed.
  if (v.status === "confirmed") {
    const { data: biz } = await db.from("clients").select("workflow_settings").eq("id", clientId).maybeSingle();
    const zone = (before.timezone as string | null)?.trim() || parseWorkflowSettings(biz?.workflow_settings).appointments.timezone;
    const changed = before.status !== "confirmed" || v.scheduled_date !== (before.scheduled_date ?? "") || v.scheduled_time !== (before.scheduled_time ?? "");
    const ok = validateSchedule({ date: v.scheduled_date, time: v.scheduled_time }, { timeZone: zone, now: new Date(), checkPast: changed });
    if (!ok.ok) return go(v.id, scheduleNotice(ok.problem));
  }

  const { error } = await db.from("appointments").update({
    status: v.status, scheduled_date: v.scheduled_date || null, scheduled_time: v.scheduled_time || null, customer_email: v.customer_email || null,
    internal_notes: v.notes || null, updated_at: new Date().toISOString(),
  }).eq("id", v.id).eq("client_id", clientId);
  // Two open requests for the same thing are not allowed (the same rule that stops the assistant saving a duplicate).
  if (error) return go(v.id, error.code === "23505" ? "appt_conflict" : "appt_failed");
  revalidatePath("/dashboard/appointments");
  revalidatePath(detail(v.id));
  return go(v.id, "appt_done");
}
