"use client";

import { useState } from "react";

// A textarea with a live character count. Still a plain form field named `name`.
export default function CountedTextarea({
  name, defaultValue = "", max, minHeight = 260, label, hint, required = false,
}: { name: string; defaultValue?: string; max: number; minHeight?: number; label: string; hint?: string; required?: boolean }) {
  const [n, setN] = useState(defaultValue.length);
  return (
    <label className="field">
      {label}
      {hint && <span className="hint">{hint}</span>}
      <textarea
        name={name} defaultValue={defaultValue} maxLength={max} required={required} style={{ minHeight }}
        onChange={(e) => setN(e.target.value.length)} aria-describedby={`${name}-count`}
      />
      <span id={`${name}-count`} className={`counter${n >= max ? " over" : ""}`} aria-live="polite">
        {n.toLocaleString()} / {max.toLocaleString()} characters
      </span>
    </label>
  );
}
