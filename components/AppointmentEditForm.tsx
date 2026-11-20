"use client";

import { useState } from "react";
import ChangeAwareSubmit from "./ChangeAwareSubmit";

// The compact "Edit appointment" form. Always visible: status, customer name, purpose, preferred date and time (what the customer
// asked for). The scheduled date and time (what you approved) appear only while the status is Confirmed, which includes the moment
// you pick Confirmed here. Type and time zone live in a fold. When the scheduled fields are hidden their current values are still
// posted, so saving never wipes them. The message to the customer is optional and nothing is sent unless the box is ticked.
export default function AppointmentEditForm({ action, a, statuses, zone }: {
  action: (formData: FormData) => void | Promise<void>;
  a: { id: string; status: string; customer_name: string | null; purpose: string; preferred_date: string | null; preferred_time: string | null; scheduled_date: string | null; scheduled_time: string | null; appointment_type: string | null; timezone: string | null; reschedule_note: string | null };
  statuses: { value: string; label: string }[];
  zone: string | null;
}) {
  const [status, setStatus] = useState(a.status);
  const confirming = status === "confirmed";
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="id" value={a.id} />
      <div className="grid2">
        <label className="field">Status
          <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">Customer name <input name="customer_name" maxLength={100} defaultValue={a.customer_name ?? ""} /></label>
      </div>
      <label className="field">Appointment purpose <input name="purpose" required maxLength={300} defaultValue={a.purpose} /></label>
      <div className="grid2">
        <label className="field">Preferred date <span className="hint">asked by the customer</span><input type="date" name="preferred_date" defaultValue={a.preferred_date ?? ""} /></label>
        <label className="field">Preferred time <span className="hint">asked by the customer</span><input name="preferred_time" maxLength={60} defaultValue={a.preferred_time ?? ""} /></label>
      </div>
      {confirming ? (
        <div className="grid2">
          <label className="field">Scheduled date <span className="hint">what you approve</span><input type="date" name="scheduled_date" required defaultValue={a.scheduled_date ?? a.preferred_date ?? ""} /></label>
          <label className="field">Scheduled time{zone ? ` (${zone})` : ""} <span className="hint">for example 10:30 or 3pm</span><input name="scheduled_time" required maxLength={60} defaultValue={a.scheduled_time ?? a.preferred_time ?? ""} /></label>
        </div>
      ) : (
        <>
          <input type="hidden" name="scheduled_date" value={a.scheduled_date ?? ""} />
          <input type="hidden" name="scheduled_time" value={a.scheduled_time ?? ""} />
        </>
      )}
      <details className="handoff-more">
        <summary>More details</summary>
        <div className="grid2" style={{ marginTop: 10 }}>
          <label className="field">Type
            <select name="appointment_type" defaultValue={a.appointment_type ?? ""}>
              <option value="">Not said</option><option value="online">Online</option><option value="in_person">In person</option>
            </select>
          </label>
          <label className="field">Time zone <input name="timezone" maxLength={60} defaultValue={a.timezone ?? ""} placeholder={zone ?? "for example Asia/Kolkata"} /></label>
        </div>
      </details>
      <label className="field">Message to the customer <span className="hint">Optional. The reason for a rejection, or the alternative you suggest for a reschedule.</span>
        <input name="note" maxLength={500} defaultValue={a.reschedule_note ?? ""} />
      </label>
      <label className="check"><input type="checkbox" name="notify" /> Tell the customer about the new status (confirmed, rejected, reschedule or cancelled)</label>
      <p className="hint">Sent as a plain message, never a template: by WhatsApp if the customer wrote within the last 24 hours, otherwise by email if they gave one. You will see exactly what happened.</p>
      <div><ChangeAwareSubmit pendingText="Saving...">Save changes</ChangeAwareSubmit></div>
    </form>
  );
}
