"use client";

import { useFormStatus } from "react-dom";

// A submit button that shows a loading state while its server action runs.
// Pure presentation: the form and its action are unchanged.
export default function SubmitButton({
  children, pendingText, variant = "primary", small = false, disabled = false, name, value,
}: {
  children: React.ReactNode; pendingText?: string; variant?: "primary" | "secondary" | "danger" | "ghost";
  small?: boolean; disabled?: boolean; name?: string; value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit" name={name} value={value} disabled={pending || disabled} aria-busy={pending}
      className={`btn btn-${variant}${small ? " btn-sm" : ""}`}
    >
      {pending && <span className="spinner" aria-hidden="true" />}
      {pending ? (pendingText ?? "Working...") : children}
    </button>
  );
}
