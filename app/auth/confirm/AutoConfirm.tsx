"use client";

import { useEffect, useRef } from "react";
import SubmitButton from "../../../components/SubmitButton";
import { confirmEmail } from "./actions";

// One-click verification. In a real browser this form submits itself as soon as the page opens, so the
// person clicks the email link once and lands on the result page. Email scanners that pre-open links
// fetch the HTML but do not run scripts, so they still cannot use up the one-time link. Without
// JavaScript the button below is the fallback. The ref makes sure it is submitted only once.
export default function AutoConfirm({ tokenHash, type }: { tokenHash: string; type: string }) {
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <form ref={form} action={confirmEmail}>
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <noscript><SubmitButton pendingText="Confirming...">Confirm my email</SubmitButton></noscript>
      <p className="muted" role="status"><span className="spinner" aria-hidden="true" /> This only takes a moment...</p>
    </form>
  );
}
