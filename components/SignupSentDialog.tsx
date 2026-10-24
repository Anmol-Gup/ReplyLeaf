"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import Icon from "./Icon";

// Shown right after sign-up. Uses the browser's native <dialog>, which traps focus,
// closes with Escape and is announced properly by screen readers.
export default function SignupSentDialog({ approval }: { approval: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="sent-title" aria-describedby="sent-text">
      <div className="empty">
        <span className="empty-icon"><Icon name="check" size={22} /></span>
        <h2 id="sent-title" style={{ fontSize: "1.2rem" }}>Verification email sent</h2>
        <p id="sent-text" className="muted">
          We&apos;ve sent you an email with a link. Please open it and verify your email address, then sign in.
          If you don&apos;t see it, check your spam folder.
          {approval ? " After that, we'll review your account and email you when your access is approved." : ""}
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <Link className="btn btn-primary" href="/login">Go to sign in</Link>
          <button type="button" className="btn btn-secondary" onClick={() => ref.current?.close()}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
