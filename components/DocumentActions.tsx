"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import SubmitButton from "./SubmitButton";

// Row actions for one document: View, then a three-dot menu holding Archive / Re-activate and Delete. Delete asks in a dialog first.
export default function DocumentActions({ id, status, setStatus, remove }: {
  id: string; status: string;
  setStatus: (formData: FormData) => void | Promise<void>;
  remove: (formData: FormData) => void | Promise<void>;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const draft = status === "draft";
  return (
    <div className="row doc-actions">
      <Link className="btn btn-sm btn-secondary" href={`/dashboard/knowledge/documents/${id}`}>{draft ? "Review" : "View"}</Link>
      <details className="menu" ref={menu}>
        <summary aria-label="More actions">⋯</summary>
        <div className="menu-panel doc-menu">
          {!draft && (
            <form action={setStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={status === "active" ? "archived" : "active"} />
              <SubmitButton variant="secondary" small pendingText="Saving...">{status === "active" ? "Archive (stop using)" : "Re-activate"}</SubmitButton>
            </form>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (menu.current) menu.current.open = false; setAsking(true); dialog.current?.showModal(); }}>Delete</button>
        </div>
      </details>
      <dialog ref={dialog} className="confirm-dialog" onClose={() => setAsking(false)} onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        {asking && (
          <form action={remove} className="stack">
            <input type="hidden" name="id" value={id} />
            <h2>{draft ? "Delete this draft?" : "Delete this document?"}</h2>
            <p className="muted">{draft ? "The draft will be removed." : "The assistant will stop using it. This cannot be undone."}</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.close()}>Cancel</button>
              <SubmitButton variant="danger" pendingText="Deleting...">Delete</SubmitButton>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
