"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import SubmitButton from "./SubmitButton";

// Tick rows in a list (a header box ticks them all) and a bar appears with "N selected" and Delete, with a confirmation first.
// The checkboxes are plain inputs named "ids" rendered by the page, so nothing is sent unless they are ticked.
export default function BulkDelete({ action, noun, children }: { action: (formData: FormData) => void | Promise<void>; noun: string; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  const [n, setN] = useState(0);
  const count = () => setN(form.current?.querySelectorAll<HTMLInputElement>("input[name=ids]:checked").length ?? 0);
  // After the page refreshes (a delete, a filter) the count and the header box follow what is really ticked.
  useEffect(() => {
    const boxes = form.current?.querySelectorAll<HTMLInputElement>("input[name=ids]");
    const all = form.current?.querySelector<HTMLInputElement>("input[data-all]");
    if (all && boxes) all.checked = boxes.length > 0 && [...boxes].every((c) => c.checked);
    count();
  });
  const onChange = (e: React.FormEvent<HTMLFormElement>) => {
    const t = e.target as unknown as HTMLInputElement;
    if (t.dataset.all !== undefined) form.current?.querySelectorAll<HTMLInputElement>("input[name=ids]").forEach((c) => { c.checked = t.checked; });
    else if (t.name === "ids") { const all = form.current?.querySelector<HTMLInputElement>("input[data-all]"); const boxes = form.current?.querySelectorAll<HTMLInputElement>("input[name=ids]"); if (all && boxes) all.checked = [...boxes].every((c) => c.checked); }
    count();
  };
  return (
    <form ref={form} action={action} onChange={onChange}
      onSubmit={(e) => { if (!window.confirm(`Delete ${n} ${noun}${n === 1 ? "" : "s"} permanently? This cannot be undone.`)) e.preventDefault(); }}>
      {n > 0 && (
        <div className="bulk-bar" role="status">
          <span><b>{n}</b> selected</span>
          <SubmitButton variant="danger" small pendingText="Deleting..."><Icon name="x" size={14} /> Delete</SubmitButton>
        </div>
      )}
      {children}
    </form>
  );
}
