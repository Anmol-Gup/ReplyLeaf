import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClient } from "../../../../../lib/auth/session";
import { fmt } from "../../../../../lib/dashboard";
import { chunkText } from "../../../../../lib/kb/chunk";
import Notice from "../../../Notice";
import {
  discardDraft, publishDocumentAction, reindexDocumentAction, restoreVersion, setDocumentStatus,
} from "../../../actions";

export const maxDuration = 60; // publishing embeds every chunk

export default async function DocumentPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: doc } = await db.from("kb_documents")
    .select("id, title, content, status, source, filename, version").eq("id", id).maybeSingle();
  if (!doc) notFound();

  const draft = doc.status === "draft";
  const chunks = chunkText(doc.content);
  const { data: versions } = await db.from("kb_document_versions")
    .select("version, title, created_at").eq("document_id", id).order("version", { ascending: false });

  return (
    <section className="card">
      <p><Link href="/dashboard/knowledge">&larr; Knowledge base</Link></p>
      <h1>{doc.title}</h1>
      <Notice code={notice} />

      {draft
        ? <p className="notice warn">Review the text below{doc.filename ? ` extracted from ${doc.filename}` : ""}. Fix anything that looks wrong. <b>Nothing is added to the assistant&apos;s knowledge until you press Confirm.</b></p>
        : <p className="muted">Status: <b>{doc.status}</b> · version {doc.version} · source {doc.source}</p>}

      <form action={publishDocumentAction} className="stack">
        <input type="hidden" name="id" value={id} />
        <label>Title<input name="title" required maxLength={200} defaultValue={doc.title} /></label>
        <label>Text<textarea name="content" required maxLength={200000} style={{ minHeight: 360 }} defaultValue={doc.content} /></label>
        <p className="muted">
          This will be split into {chunks.length} searchable section{chunks.length === 1 ? "" : "s"}
          {chunks.some((c) => c.heading) ? ": " + [...new Set(chunks.map((c) => c.heading).filter(Boolean))].slice(0, 8).join("; ") : ". Tip: add # headings to separate topics."}
        </p>
        <div><button type="submit">{draft ? "Confirm and publish" : "Save as new version"}</button></div>
      </form>

      {draft ? (
        <form action={discardDraft} style={{ marginTop: 12 }}>
          <input type="hidden" name="id" value={id} />
          <button className="secondary" type="submit">Discard draft</button>
        </form>
      ) : (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <form action={setDocumentStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={doc.status === "active" ? "archived" : "active"} />
              <button className="secondary" type="submit">{doc.status === "active" ? "Archive (stop using)" : "Re-activate"}</button>
            </form>
            {doc.status === "active" && (
              <form action={reindexDocumentAction}>
                <input type="hidden" name="id" value={id} />
                <button className="secondary" type="submit">Re-index search</button>
              </form>
            )}
          </div>

          <h2>Version history</h2>
          <table>
            <thead><tr><th>Version</th><th>Title</th><th>Saved</th><th></th></tr></thead>
            <tbody>
              {(versions ?? []).map((v) => (
                <tr key={v.version}>
                  <td>{v.version}{v.version === doc.version && <> <span className="badge ok">current</span></>}</td>
                  <td>{v.title}</td><td>{fmt(v.created_at)}</td>
                  <td>{v.version !== doc.version && (
                    <form action={restoreVersion}>
                      <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={v.version} />
                      <button className="secondary" type="submit">Restore as new version</button>
                    </form>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
