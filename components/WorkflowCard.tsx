"use client";

import { useState } from "react";

// One workflow on the Settings page: a switch, and its settings below. Switched off, the settings are hidden;
// switched on, they are shown and can be folded away. Hidden fields are only hidden with CSS, so they are
// still submitted with the form and the saved values are never lost.
export default function WorkflowCard({ name, title, description, switchLabel, defaultChecked, children }: {
  name: string; title: string; description: string; switchLabel: string; defaultChecked: boolean; children: React.ReactNode;
}) {
  const [on, setOn] = useState(defaultChecked);
  const [open, setOpen] = useState(true);
  const shown = on && open;
  return (
    <section className={`card wf${on ? " wf-on" : ""}`}>
      <div className="wf-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">{description}</p>
        </div>
        <label className="wf-switch">
          <input type="checkbox" name={name} checked={on} onChange={(e) => { setOn(e.target.checked); if (e.target.checked) setOpen(true); }} />
          <span>{switchLabel}</span>
        </label>
      </div>
      {on && (
        <button type="button" className="wf-fold" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide settings" : "Show settings"}
        </button>
      )}
      {!on && <p className="hint wf-off">Off. Your saved settings are kept and come back when you switch it on.</p>}
      <div className="stack wf-body" style={{ display: shown ? undefined : "none" }}>{children}</div>
    </section>
  );
}
