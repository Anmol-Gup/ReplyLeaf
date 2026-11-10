"use client";

import { useState } from "react";

// Copies text to the clipboard. The text is passed in by the (server) page; nothing is fetched here.
export default function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button" className="btn btn-secondary btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("done");
        } catch {
          setState("failed"); // clipboard blocked: the text is still visible on the page to copy by hand
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Could not copy: select the text" : label}
      <span className="sr-only" role="status">{state === "done" ? "Copied to clipboard" : ""}</span>
    </button>
  );
}
