"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

// A property you change by clicking it, like HubSpot: the value turns into a field, Enter or leaving a text field saves it, picking
// from a list saves at once, Escape cancels. The server action still gets every current value of the record (the hidden ones), so a
// change to one property never touches the others. Some properties need a second step (a reveal): choosing "Confirmed" asks for a
// date and time first, and the status can carry a "Notify customer" box; those use Save and Cancel instead of saving on their own.
export type InlineControl = {
  name: string; kind: "text" | "select" | "date" | "email" | "checkbox" | "textarea"; value: string;
  options?: { value: string; label: string }[]; label?: string; placeholder?: string; required?: boolean; maxLength?: number;
  reveal?: boolean; // shown only when the revealWhen value is picked
};

export default function InlineProp({ label, display, action, hidden, controls, revealWhen, alwaysConfirm = false, emptyText = "Click to add", disabled = false }: {
  label: string; display: React.ReactNode; action: (formData: FormData) => void | Promise<void>; hidden: Record<string, string>;
  controls: InlineControl[]; revealWhen?: { control: string; value: string }; alwaysConfirm?: boolean; emptyText?: string; disabled?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(controls.map((c) => [c.name, c.value])));
  const [sending, setSending] = useState(false);
  // After the server has answered (the page refreshed with new values or a notice) the field goes back to showing the value.
  const search = useSearchParams().toString();
  const sig = JSON.stringify(controls.map((c) => c.value)) + search;
  useEffect(() => { setValues(Object.fromEntries(controls.map((c) => [c.name, c.value]))); setEditing(false); setSending(false); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => { if (sending) return; if (form.current && !form.current.checkValidity()) { form.current.reportValidity(); return; } setSending(true); form.current?.requestSubmit(); };
  const set = (name: string, v: string) => setValues((x) => ({ ...x, [name]: v }));
  const revealed = !!revealWhen && values[revealWhen.control] === revealWhen.value;
  const needsSave = alwaysConfirm || revealed || controls.some((c) => c.kind === "checkbox" || c.kind === "textarea");
  const visible = controls.filter((c) => !c.reveal || revealed);
  const cancel = () => { setValues(Object.fromEntries(controls.map((c) => [c.name, c.value]))); setEditing(false); };

  if (!editing) {
    return (
      <div className="rec-prop">
        <small>{label}</small>
        {disabled ? <span>{display}</span> : (
          <button type="button" className="inline-view" onClick={() => setEditing(true)} aria-label={`Edit ${label}`}>
            <span>{display ?? <span className="muted">{emptyText}</span>}</span><Icon name="settings" size={14} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="rec-prop">
      <small>{label}</small>
      <form ref={form} action={action} className="inline-form" onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}>
        {Object.entries(hidden).filter(([k]) => !visible.some((c) => c.name === k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        {visible.map((c) => c.kind === "select" ? (
          <select key={c.name} name={c.name} value={values[c.name]} autoFocus aria-label={c.label ?? label}
            onChange={(e) => { set(c.name, e.target.value); const reveal = revealWhen && c.name === revealWhen.control && e.target.value === revealWhen.value; if (!needsSave && !reveal) setTimeout(submit, 0); }}
            onBlur={() => { if (!needsSave && !sending) setTimeout(() => { if (!sending && form.current && !form.current.contains(document.activeElement)) cancel(); }, 150); }}>
            {c.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : c.kind === "textarea" ? (
          <textarea key={c.name} name={c.name} rows={5} value={values[c.name]} autoFocus required={c.required} maxLength={c.maxLength} placeholder={c.placeholder} aria-label={c.label ?? label} onChange={(e) => set(c.name, e.target.value)} />
        ) : c.kind === "checkbox" ? (
          <label key={c.name} className="check"><input type="checkbox" name={c.name} checked={values[c.name] === "on"} onChange={(e) => set(c.name, e.target.checked ? "on" : "")} /> {c.label}</label>
        ) : (
          <input key={c.name} name={c.name} type={c.kind} value={values[c.name]} autoFocus={!c.reveal} required={c.required} maxLength={c.maxLength} placeholder={c.placeholder} aria-label={c.label ?? label}
            onChange={(e) => set(c.name, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !needsSave) { e.preventDefault(); submit(); } }}
            onBlur={() => { if (!needsSave && !sending) setTimeout(() => { if (!sending && form.current && !form.current.contains(document.activeElement)) { if (values[c.name] !== c.value) submit(); else cancel(); } }, 150); }} />
        ))}
        {needsSave && (
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={submit}>{sending ? "Saving..." : "Save"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
          </div>
        )}
      </form>
    </div>
  );
}
