"use client";

import { useState } from "react";
import ChangeAwareSubmit from "./ChangeAwareSubmit";

// Update an appointment after you have talked to the customer: set the status, and when it is Confirmed, the date and time you
// agreed. Your private note is saved with it. Nothing is sent to the customer. When the agreed date and time are hidden their
// values are still posted, so saving never wipes them.
export default function AppointmentEditForm({ action, a, statuses }: {
  action: (formData: FormData) => void | Promise<void>;
  a: { id: string; status: string; scheduled_date: string | null; scheduled_time: string | null; preferred_date: string | null; preferred_time: string | null; internal_notes: string | null };
  statuses: { value: string; label: string }[];
}) {
  const [status, setStatus] = useState(a.status);
  const confirmed = status === "confirmed";
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="id" value={a.id} />
      <label className="field">Status
        <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      {confirmed ? (
        <div className="grid2">
          <label className="field">Agreed date <input type="date" name="scheduled_date" required defaultValue={a.scheduled_date ?? a.preferred_date ?? ""} /></label>
          <label className="field">Agreed time <span className="hint">for example 10:30 or 3pm</span><input name="scheduled_time" required maxLength={60} defaultValue={a.scheduled_time ?? a.preferred_time ?? ""} /></label>
        </div>
      ) : (
        <>
          <input type="hidden" name="scheduled_date" value={a.scheduled_date ?? ""} />
          <input type="hidden" name="scheduled_time" value={a.scheduled_time ?? ""} />
        </>
      )}
      <label className="field">Note <span className="hint">Private. Only you see it.</span><textarea name="notes" rows={3} maxLength={2000} defaultValue={a.internal_notes ?? ""} /></label>
      <div><ChangeAwareSubmit pendingText="Saving...">Save</ChangeAwareSubmit></div>
    </form>
  );
}
