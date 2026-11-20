"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { filterHref, selectionSummary } from "../lib/filters";

// A multi-select dropdown for a list's status filter. Tick as many statuses as you like (or "Select all"), then press Apply: nothing
// changes in the list until you do. Reset clears the choice. The choice lives in the address (?status=a&status=b), the search text and
// other switches travel along, and the page number is dropped (a new filter starts on page 1). Without JavaScript it is still a plain
// GET form, so Apply works. The dropdown closes when the list has updated and when you click elsewhere.
export default function MultiSelectFilter({ action, label = "Status", param = "status", options, selected, hidden = {} }: {
  action: string; label?: string; param?: string;
  options: { value: string; label: string; count: number }[];
  selected: string[];
  hidden?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const box = useRef<HTMLDetailsElement>(null);
  const [checked, setChecked] = useState<string[]>(selected);   // what is ticked now (not applied yet)
  const [pending, start] = useTransition();
  const key = selected.join(",");
  const allValues = options.map((o) => o.value);
  const allTicked = allValues.every((v) => checked.includes(v));
  const changed = checked.slice().sort().join(",") !== selected.slice().sort().join(",");

  // The page answered with a new selection: show it, and fold the dropdown away.
  useEffect(() => {
    setChecked(selected);
    if (box.current) box.current.open = false;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current?.open && !box.current.contains(e.target as Node)) box.current.open = false; };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const apply = (values: string[]) => {
    if (values.slice().sort().join(",") === selected.slice().sort().join(",") && values.length > 0) { if (box.current) box.current.open = false; return; } // nothing to change
    start(() => router.push(filterHref(action, values, hidden, param)));
  };

  return (
    <details className="msel" ref={box}>
      <summary className="btn btn-secondary btn-sm" aria-label={`${label} filter`} aria-busy={pending}>
        {label}: <b>{selectionSummary(selected, options)}</b>{pending && <span className="spinner" aria-hidden="true" style={{ marginLeft: 8 }} />}
      </summary>
      <form method="get" action={action} className="msel-panel" onSubmit={(e) => { e.preventDefault(); apply(checked); }}>
        {Object.entries(hidden).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        <fieldset>
          <legend className="hint">Show items with any of these {label.toLowerCase()}es</legend>
          <label className="check msel-all">
            <input type="checkbox" checked={allTicked} onChange={(e) => setChecked(e.target.checked ? allValues : [])} /> <b>Select all</b>
          </label>
          {options.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" name={param} value={o.value} checked={checked.includes(o.value)}
                onChange={(e) => setChecked(allValues.filter((v) => (v === o.value ? e.target.checked : checked.includes(v))))} /> {o.label} <span className="tab-count">{o.count}</span>
            </label>
          ))}
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending} aria-busy={pending}>
            {pending && <span className="spinner" aria-hidden="true" />}{pending ? "Applying..." : changed ? "Apply" : "Apply"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => { setChecked([]); start(() => router.push(filterHref(action, [], hidden, param))); }}>Reset</button>
        </div>
      </form>
    </details>
  );
}
