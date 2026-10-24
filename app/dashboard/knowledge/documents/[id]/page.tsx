import Link from "next/link";
import { notFound } from "next/navigation";
import CountedTextarea from "../../../../../components/CountedTextarea";
import Icon from "../../../../../components/Icon";
import SubmitButton from "../../../../../components/SubmitButton";
import { Alert, Badge, Card, PageHeader, type Tone } from "../../../../../components/ui";
import { requireClient } from "../../../../../lib/auth/session";
import { fmt } from "../../../../../lib/dashboard";
import { chunkText } from "../../../../../lib/kb/chunk";
import Notice from "../../../Notice";
import {
  discardDraft, publishDocumentAction, reindexDocumentAction, restoreVersion, setDocumentStatus,
} from "../../../actions";

export const maxDuration = 60; // publishing embeds every chunk

const TONE: Record<string, Tone> = { active: "success", draft: "warn", archived: "muted" };

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
  const headings = [...new Set(chunks.map((c) => c.heading).filter(Boolean))].slice(0, 8).join("; ");

  return (
    <>
      <Link href="/dashboard/knowledge" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}><Icon name="back" size={16} /> Knowledge base</Link>
      <PageHeader title={doc.title} actions={<Badge tone={TONE[doc.status] ?? "muted"}>{doc.status}</Badge>} description={draft ? undefined : `Version ${doc.version} · source ${doc.source}`} />
      <Notice code={notice} />
      {draft && (
        <Alert kind="warn">
          Review the text below{doc.filename ? ` extracted from ${doc.filename}` : ""}. Fix anything that looks wrong.{" "}
          <b>Nothing is added to the assistant&apos;s knowledge until you press Confirm.</b>
        </Alert>
      )}

      <Card title={draft ? "Extracted text" : "Content"}>
        <form action={publishDocumentAction} className="stack">
          <input type="hidden" name="id" value={id} />
          <label className="field">Title<input name="title" required maxLength={200} defaultValue={doc.title} /></label>
          <CountedTextarea name="content" label="Text" max={200000} minHeight={360} defaultValue={doc.content} required />
          <p className="muted">
            This will be split into {chunks.length} searchable section{chunks.length === 1 ? "" : "s"}
            {headings ? `: ${headings}` : ". Tip: add # headings to separate topics."}
          </p>
          <div><SubmitButton pendingText={draft ? "Publishing..." : "Saving..."}>{draft ? "Confirm and publish" : "Save as new version"}</SubmitButton></div>
        </form>
        {draft && (
          <form action={discardDraft} style={{ marginTop: 12 }}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton variant="secondary" pendingText="Discarding...">Discard draft</SubmitButton>
          </form>
        )}
      </Card>

      {!draft && (
        <>
          <div className="row">
            <form action={setDocumentStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={doc.status === "active" ? "archived" : "active"} />
              <SubmitButton variant="secondary" pendingText="Saving...">{doc.status === "active" ? "Archive (stop using)" : "Re-activate"}</SubmitButton>
            </form>
            {doc.status === "active" && (
              <form action={reindexDocumentAction}>
                <input type="hidden" name="id" value={id} />
                <SubmitButton variant="secondary" pendingText="Re-indexing...">Re-index search</SubmitButton>
              </form>
            )}
          </div>
          <Card title="Version history">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>Title</th><th>Saved</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {(versions ?? []).map((v) => (
                    <tr key={v.version}>
                      <td>{v.version}{v.version === doc.version && <> <Badge tone="success">current</Badge></>}</td>
                      <td>{v.title}</td><td>{fmt(v.created_at)}</td>
                      <td>{v.version !== doc.version && (
                        <form action={restoreVersion}>
                          <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={v.version} />
                          <SubmitButton small variant="secondary" pendingText="Restoring...">Restore as new version</SubmitButton>
                        </form>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
