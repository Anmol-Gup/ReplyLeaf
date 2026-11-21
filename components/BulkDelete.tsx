"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

// Tick rows in a list (a header box ticks them all) and a bar appears with "N selected" and Delete, with a confirmation first.
// The checkboxes are plain inputs named "ids" rendered by the page, so nothing is sent unless they are ticked.
export default function BulkDelete({ action, noun, children }: { action: (formData: FormData) => void | Promise<void>; noun: string; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  const [n, setN] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null); // the spot next to the search box on the page
  useEffect(() => setSlot(document.getElementById("bulk-slot")), []);
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
    <form id="bulk-form" ref={form} action={action} onChange={onChange}
      onSubmit={(e) => { if (!window.confirm(`Delete ${n} ${noun}${n === 1 ? "" : "s"} permanently? This cannot be undone.`)) e.preventDefault(); }}>
      {n > 0 && slot && createPortal(
        <button type="submit" form="bulk-form" className="btn btn-danger btn-sm"><Icon name="x" size={14} /> Delete ({n})</button>, slot)}
      {children}
    </form>
  );
}
