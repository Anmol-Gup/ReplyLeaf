"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { emailAssignee, resolveAssignee } from "../../../lib/assign";
import { requirePaidAccess } from "../../../lib/billing/gate";
import { parseIds } from "../../../lib/bulk";
import { requireClient } from "../../../lib/auth/session";
import { noteSchema } from "../../../lib/notes";
import { notifyCustomerDetailed } from "../../../lib/appointment-notify";
import { appointmentStatusMessage, appointmentUpdateSchema, deliveryNotice, needsSchedule, scheduleNotice, validateSchedule, whenText } from "../../../lib/appointments";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { parseWorkflowSettings } from "../../../lib/workflow-settings";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the signed-in owner's membership;
// writes use the service role and every query filters by that clientId. Form ids are never trusted on their own.
// Nothing here contacts the customer: the owner talks to them directly and records the outcome.

const detail = (id: string) => `/dashboard/appointments/${id}`;
const go = (id: string, notice: string): never => redirect(`${detail(id)}?notice=${notice}`);

export async function updateAppointment(formData: FormData) {
  const { clientId, clientName, user } = await requireClient();
  await requirePaidAccess(clientId);
  const rawId = String(formData.get("id") ?? "");
  const text = (n: string) => String(formData.get(n) ?? "");
  const notify = formData.get("notify") !== null; // telling the customer is opt-in
  const parsed = appointmentUpdateSchema.safeParse({ id: formData.get("id"), status: formData.get("status"), scheduled_date: text("scheduled_date"), scheduled_time: text("scheduled_time"), customer_email: text("customer_email"), notes: formData.has("notes") ? text("notes") : undefined });
  if (!parsed.success) return z.string().uuid().safeParse(rawId).success ? go(rawId, "invalid") : redirect("/dashboard/appointments?notice=invalid");
  const v = parsed.data;

  const db = supabaseAdmin();
  const { data: before } = await db.from("appointments").select("id, conversation_id, status, scheduled_date, scheduled_time, timezone, customer_name, customer_phone, purpose").eq("id", v.id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/appointments?notice=not_found");

  // A confirmed or rescheduled appointment must have the agreed date and a clock time. The date is checked against today only when it is new or
  // changed, so an old confirmed appointment can still be marked completed after its date has passed.
  if (needsSchedule(v.status)) {
    const { data: biz } = await db.from("clients").select("workflow_settings").eq("id", clientId).maybeSingle();
    const zone = (before.timezone as string | null)?.trim() || parseWorkflowSettings(biz?.workflow_settings).appointments.timezone;
    const changed = before.status !== v.status || v.scheduled_date !== (before.scheduled_date ?? "") || v.scheduled_time !== (before.scheduled_time ?? "");
    const ok = validateSchedule({ date: v.scheduled_date, time: v.scheduled_time }, { timeZone: zone, now: new Date(), checkPast: changed });
    if (!ok.ok) return go(v.id, scheduleNotice(ok.problem));
  }

  // Assign by typed email (only when posted): empty = unassigned, otherwise recorded and the person is emailed.
  const typed = formData.has("assignee_email") ? await resolveAssignee(clientId, user, formData.get("assignee_email")) : undefined;
  if (typed === null) return go(v.id, "invalid");
  // Read lazily so a database without migration 0028 still saves every other change.
  const prevAssignee = typed ? ((await db.from("appointments").select("assigned_to").eq("id", v.id).eq("client_id", clientId).maybeSingle()).data?.assigned_to as string | null | undefined) ?? null : null;
  const { error } = await db.from("appointments").update({
    ...(typed ? { assigned_to: typed.email } : {}),
    status: v.status, scheduled_date: v.scheduled_date || null, scheduled_time: v.scheduled_time || null, customer_email: v.customer_email || null,
    ...(v.notes !== undefined ? { internal_notes: v.notes || null } : {}), updated_at: new Date().toISOString(),
  }).eq("id", v.id).eq("client_id", clientId);
  // Two open requests for the same thing are not allowed (the same rule that stops the assistant saving a duplicate).
  // 23514: the database has not had migration 0032 yet (it does not know the newest statuses), so nothing was saved.
  if (error) return go(v.id, error.code === "23505" ? "appt_conflict" : error.code === "23514" ? "appt_needs_update" : "appt_failed");
  revalidatePath("/dashboard/appointments");
  revalidatePath("/dashboard"); // the Overview counts change too
  revalidatePath(detail(v.id));
  let assignEmailFailed = false;
  if (typed && typed.email && typed.email !== prevAssignee) {
    assignEmailFailed = !(await emailAssignee(typed, { kind: "appointment", title: before.purpose as string, customerName: (before.customer_name as string | null) ?? null, phone: (before.customer_phone as string | null) ?? "", detailLabel: "Details", detail: "", path: detail(v.id), assignedBy: user.email ?? "A teammate", businessName: clientName }));
  }

  // Telling the customer is opt-in, and only when the status or the agreed time really changed (so a double click or a repeat save never
  // sends twice). WhatsApp if the 24-hour window is open, else email, else nothing is sent and the owner is told. Internal notes and the
  // assignee are never part of the message.
  if (notify) {
    const changed = v.status !== before.status || v.scheduled_date !== ((before.scheduled_date as string | null) ?? "") || v.scheduled_time !== ((before.scheduled_time as string | null) ?? "");
    if (!changed) return go(v.id, "appt_nothing_to_notify");
    const when = needsSchedule(v.status) ? whenText(v.scheduled_date, v.scheduled_time) : "";
    const message = appointmentStatusMessage(clientName, before.purpose as string, v.status, when, text("message"));
    const sent = await notifyCustomerDetailed(clientId, before.conversation_id as string, clientName, "Update on your appointment", message, v.customer_email || null);
    return go(v.id, deliveryNotice("appt", sent.channel));
  }
  if (assignEmailFailed) return go(v.id, "assign_email_failed");
  return go(v.id, "appt_done");
}

// Permanent delete of one appointment request. The contact and the conversation are not touched.
export async function deleteAppointment(formData: FormData) {
  const { clientId } = await requireClient();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return redirect("/dashboard/appointments?notice=invalid");
  await supabaseAdmin().from("appointments").delete().eq("id", id.data).eq("client_id", clientId);
  revalidatePath("/dashboard/appointments");
  revalidatePath("/dashboard"); // the Overview counts change too
  redirect("/dashboard/appointments?notice=record_deleted");
}

// Delete several appointments at once (the ones ticked in the list). Only this business's rows can match.
export async function bulkDeleteAppointments(formData: FormData) {
  const { clientId } = await requireClient();
  const ids = parseIds(formData.getAll("ids"));
  if (ids.length === 0) return redirect("/dashboard/appointments?notice=invalid");
  await supabaseAdmin().from("appointments").delete().in("id", ids).eq("client_id", clientId);
  revalidatePath("/dashboard/appointments");
  revalidatePath("/dashboard"); // the Overview counts change too
  redirect("/dashboard/appointments?notice=record_deleted");
}

// A private note on an appointment: any number of them, each kept with its author and time. Never sent to the customer.
export async function addAppointmentNote(formData: FormData) {
  const { clientId, user } = await requireClient();
  const parsed = noteSchema.safeParse({ id: formData.get("id"), body: String(formData.get("body") ?? "") });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    return /^[0-9a-f-]{36}$/i.test(id) ? go(id, "note_empty") : redirect("/dashboard/appointments?notice=invalid");
  }
  const db = supabaseAdmin();
  const { data: appt } = await db.from("appointments").select("id").eq("id", parsed.data.id).eq("client_id", clientId).maybeSingle();
  if (!appt) return redirect("/dashboard/appointments?notice=not_found");
  const { error } = await db.from("appointment_notes").insert({ client_id: clientId, appointment_id: parsed.data.id, author_user_id: user.id, author_label: user.email ?? null, body: parsed.data.body });
  if (error) return go(parsed.data.id, error.code === "42P01" || error.code === "PGRST205" ? "notes_needs_update" : "invalid");
  revalidatePath(detail(parsed.data.id));
  return go(parsed.data.id, "note_added");
}
