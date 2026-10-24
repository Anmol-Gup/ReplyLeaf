import Link from "next/link";
import CountedTextarea from "../../../components/CountedTextarea";
import Icon from "../../../components/Icon";
import SubmitButton from "../../../components/SubmitButton";
import { Badge, Card, EmptyState, ErrorState, PageHeader, type Tone } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmtDay } from "../../../lib/dashboard";
import Notice from "../Notice";
import { createDocument, resolveQuestion, updateKnowledge } from "../actions";

export const maxDuration = 60; // uploads are chunked and embedded inside the server action

const TONE: Record<string, Tone> = { active: "success", draft: "warn", archived: "muted" };

export default async function Knowledge({ searchParams }: { searchParams: Promise<{ notice?: string; why?: string }> }) {
  const { notice, why } = await searchParams;
  const { db, clientId } = await requireClient();
  const [{ data: client }, { data: docs, error: docsError }, { data: questions }] = await Promise.all([
    db.from("clients").select("kb_text").eq("id", clientId).single(),
    db.from("kb_documents").select("id, title, status, source, version, updated_at").order("updated_at", { ascending: false }).limit(200),
    db.from("unanswered_questions").select("id, question, created_at").eq("status", "open").order("created_at", { ascending: false }).limit(50),
  ]);

  return (
    <>
      <PageHeader title="Knowledge base" description="The assistant answers ONLY from what is here. If something is missing it tells the customer it will check with your team." />
      <Notice code={notice} why={why} />

      <Card title="Core knowledge" description="Always included with every message. Keep it short: opening hours, headline prices, the facts customers ask about most.">
        <form action={updateKnowledge} className="stack">
          <CountedTextarea name="kb_text" max={8000} defaultValue={client?.kb_text ?? ""} label="Core knowledge" minHeight={220} />
          <div className="row">
            <SubmitButton pendingText="Saving...">Save core knowledge</SubmitButton>
            <span className="hint">You will see a &quot;Saved&quot; confirmation at the top.</span>
          </div>
        </form>
      </Card>

      <Card title="Documents" description="Longer material such as price lists, policies and FAQs. For each question only the most relevant parts are looked up. Use # headings to keep topics separate.">
        {docsError ? <ErrorState>Your documents could not be loaded.</ErrorState> : (docs ?? []).length === 0 ? (
          <EmptyState icon="book" title="No documents yet">Upload a file or paste text below.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Title</th><th>Status</th><th>Source</th><th>Version</th><th>Updated</th></tr></thead>
              <tbody>
                {(docs ?? []).map((d) => (
                  <tr key={d.id}>
                    <td><Link href={`/dashboard/knowledge/documents/${d.id}`}>{d.title}</Link></td>
                    <td><Badge tone={TONE[d.status] ?? "muted"}>{d.status === "draft" ? "Draft: needs your confirmation" : d.status}</Badge></td>
                    <td>{d.source}</td><td>{d.version || "-"}</td><td>{fmtDay(d.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Add a document" description="You will see the extracted text first and must confirm it before the assistant can use it.">
        <form action={createDocument} className="stack" id="add-document">
          <label className="field">Title <span className="hint">Optional for files</span><input name="title" maxLength={200} /></label>
          <label className="field"><span><Icon name="upload" size={15} /> Upload a file</span>
            <span className="hint">PDF, DOCX or TXT (also .md), up to 2 MB</span>
            <input name="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" />
          </label>
          <label className="field">...or paste text<textarea name="text" style={{ minHeight: 160 }} maxLength={200000} /></label>
          <div><SubmitButton pendingText="Reading...">Continue to preview</SubmitButton></div>
        </form>
      </Card>

      <Card title="Questions the assistant couldn't answer" description="Add the answer to your knowledge base, then mark the question done.">
        {(questions ?? []).length === 0 ? (
          <EmptyState icon="check" title="Nothing unanswered right now" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Question</th><th>Asked</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(questions ?? []).map((q) => (
                  <tr key={q.id}>
                    <td>{q.question}</td><td>{fmtDay(q.created_at)}</td>
                    <td>
                      <div className="row">
                        {(["resolved", "dismissed"] as const).map((s) => (
                          <form key={s} action={resolveQuestion}>
                            <input type="hidden" name="id" value={q.id} /><input type="hidden" name="status" value={s} />
                            <SubmitButton small variant="secondary" pendingText="Saving...">{s === "resolved" ? "I added the answer" : "Dismiss"}</SubmitButton>
                          </form>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
