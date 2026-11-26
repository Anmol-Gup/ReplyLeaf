"use client";

import { useState } from "react";
import { needsSchedule } from "../lib/appointments";
import ChangeAwareSubmit from "./ChangeAwareSubmit";

// Update an appointment after you have talked to the customer: set the status, and when it is Confirmed, the date and time you
// agreed. (This form does not notify the customer; the appointment page's inline status does.) When the agreed date and time are hidden their
// values are still posted, so saving never wipes them.
export default function AppointmentEditForm({ action, a, statuses, cancelHref }: {
  cancelHref?: string;
  action: (formData: FormData) => void | Promise<void>;
  a: { id: string; status: string; scheduled_date: string | null; scheduled_time: string | null; preferred_date: string | null; preferred_time: string | null; customer_email: string | null };
  statuses: { value: string; label: string }[];
}) {
  const [status, setStatus] = useState(a.status);
  const confirmed = needsSchedule(status);
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
      <label className="field">Email <span className="hint">Optional. Add it if the customer gives it to you.</span><input type="email" name="customer_email" maxLength={200} autoComplete="off" defaultValue={a.customer_email ?? ""} /></label>
      <div className="row"><ChangeAwareSubmit pendingText="Saving...">Save</ChangeAwareSubmit>{cancelHref && <a className="btn btn-ghost btn-sm" href={cancelHref}>Cancel</a>}</div>
    </form>
  );
}
