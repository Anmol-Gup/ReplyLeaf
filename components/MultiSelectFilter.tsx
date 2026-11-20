"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { filterHref, selectionSummary } from "../lib/filters";

// A multi-select dropdown for a list's status filter. Tick or untick a status and the list updates straight away (no need to press
// Apply, though Apply and Reset are there too). The choice lives in the address (?status=a&status=b), the search text and other
// switches travel along, and the page number is dropped (a new filter starts on page 1). Without JavaScript it is still a plain
// GET form, so Apply works. The dropdown closes itself when the list has updated and when you click elsewhere.
export default function MultiSelectFilter({ action, label = "Status", param = "status", options, selected, hidden = {} }: {
  action: string; label?: string; param?: string;
  options: { value: string; label: string; count: number }[];
  selected: string[];
  hidden?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const box = useRef<HTMLDetailsElement>(null);
  const [checked, setChecked] = useState<string[]>(selected);
  const [pending, start] = useTransition();
  const key = selected.join(",");

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

  const go = (values: string[]) => start(() => router.push(filterHref(action, values, hidden, param)));
  const toggle = (value: string, on: boolean) => {
    const next = options.map((o) => o.value).filter((v) => (v === value ? on : checked.includes(v)));
    setChecked(next);
    go(next);
  };

  return (
    <details className="msel" ref={box}>
      <summary className="btn btn-secondary btn-sm" aria-label={`${label} filter`} aria-busy={pending}>
        {label}: <b>{selectionSummary(checked, options)}</b>{pending && <span className="spinner" aria-hidden="true" style={{ marginLeft: 8 }} />}
      </summary>
      <form method="get" action={action} className="msel-panel" onSubmit={(e) => { e.preventDefault(); go(checked); }}>
        {Object.entries(hidden).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        <fieldset>
          <legend className="hint">Show items with any of these {label.toLowerCase()}es</legend>
          {options.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" name={param} value={o.value} checked={checked.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} /> {o.label} <span className="tab-count">{o.count}</span>
            </label>
          ))}
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary btn-sm">Apply</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setChecked([]); go([]); }}>Reset</button>
        </div>
      </form>
    </details>
  );
}
