"use client";

import { useEffect, useRef, useState } from "react";
import SubmitButton from "./SubmitButton";

// A save button that stays disabled until something in its form has changed. It remembers what the form held when it
// appeared and compares on every edit, so changing a letter and changing it back disables the button again.
// The server checks for "nothing changed" as well, so this is a convenience, not the guard.
export default function ChangeAwareSubmit({ children, pendingText }: { children: React.ReactNode; pendingText?: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) { setChanged(true); return; } // never lock someone out of saving
    const snapshot = () => JSON.stringify(Array.from(new FormData(form).entries()).filter(([, v]) => typeof v === "string"));
    const initial = snapshot();
    const update = () => setChanged(snapshot() !== initial);
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => { form.removeEventListener("input", update); form.removeEventListener("change", update); };
  }, []);
  return (
    <>
      <span ref={marker} hidden />
      <SubmitButton pendingText={pendingText} disabled={!changed}>{children}</SubmitButton>
      {!changed && <span className="hint" style={{ marginLeft: 10 }}>No changes to save yet.</span>}
    </>
  );
}
