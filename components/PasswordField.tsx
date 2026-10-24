"use client";

import { useId, useState } from "react";
import Icon from "./Icon";

// A password input with a show/hide button. It is still a normal form field named `name`, so the
// server actions are unchanged. The toggle is a real button: keyboard reachable, with a label
// that says what pressing it does, and `aria-pressed` for screen readers.
export default function PasswordField({
  label = "Password", name = "password", autoComplete, hint, minLength, maxLength = 200, required = true,
}: { label?: string; name?: string; autoComplete: "current-password" | "new-password"; hint?: string; minLength?: number; maxLength?: number; required?: boolean }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label} {hint && <span className="hint">{hint}</span>}</label>
      <span className="pw">
        <input id={id} name={name} type={show ? "text" : "password"} required={required} minLength={minLength} maxLength={maxLength} autoComplete={autoComplete} />
        <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
          <Icon name={show ? "eyeOff" : "eye"} size={18} />
        </button>
      </span>
    </div>
  );
}
