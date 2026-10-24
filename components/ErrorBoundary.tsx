"use client";

import Link from "next/link";
import Icon from "./Icon";

// Shared body for error.tsx files: a friendly message and a retry, no stack traces.
export default function ErrorBoundary({ error, reset, home }: { error: Error & { digest?: string }; reset: () => void; home: string }) {
  return (
    <div className="empty" role="alert" style={{ minHeight: "50vh", justifyContent: "center" }}>
      <span className="empty-icon danger"><Icon name="alert" size={22} /></span>
      <h1 style={{ fontSize: "1.25rem" }}>Something went wrong</h1>
      <p className="muted">We couldn&apos;t show this page. Please try again. If it keeps happening, contact support{error.digest ? ` and quote reference ${error.digest}` : ""}.</p>
      <div className="row" style={{ justifyContent: "center" }}>
        <button type="button" className="btn btn-primary" onClick={reset}>Try again</button>
        <Link className="btn btn-secondary" href={home}>Go back</Link>
      </div>
    </div>
  );
}
