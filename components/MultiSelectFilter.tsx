import Link from "next/link";
import { selectionSummary } from "../lib/filters";

// A multi-select dropdown for a list's status filter. It is a plain HTML <details> with a GET form inside, so it works
// without any script: tick the statuses, press Apply, and the page reloads with ?status=a&status=b. The search text
// travels along as a hidden field, and the page number is dropped (a new filter starts on page 1).
export default function MultiSelectFilter({ action, label = "Status", param = "status", options, selected, hidden = {} }: {
  action: string; label?: string; param?: string;
  options: { value: string; label: string; count: number }[];
  selected: string[];
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <details className="msel">
      <summary className="btn btn-secondary btn-sm" aria-label={`${label} filter`}>{label}: <b>{selectionSummary(selected, options)}</b></summary>
      <form method="get" action={action} className="msel-panel">
        {Object.entries(hidden).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        <fieldset>
          <legend className="hint">Show items with any of these {label.toLowerCase()}es</legend>
          {options.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" name={param} value={o.value} defaultChecked={selected.includes(o.value)} /> {o.label} <span className="tab-count">{o.count}</span>
            </label>
          ))}
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary btn-sm">Apply</button>
          <Link className="btn btn-ghost btn-sm" href={hidden.q ? `${action}?q=${encodeURIComponent(hidden.q)}` : action}>Reset</Link>
        </div>
      </form>
    </details>
  );
}
