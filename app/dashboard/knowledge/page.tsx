import Link from "next/link";
import { requireClient } from "../../../lib/auth/session";
import { fmt } from "../../../lib/dashboard";
import Notice from "../Notice";
import { createDocument, resolveQuestion, updateKnowledge } from "../actions";

export const maxDuration = 60; // uploads are chunked and embedded inside the server action

export default async function Knowledge({ searchParams }: { searchParams: Promise<{ notice?: string; why?: string }> }) {
  const { notice, why } = await searchParams;
  const { db, clientId } = await requireClient();
  const [{ data: client }, { data: docs }, { data: questions }] = await Promise.all([
    db.from("clients").select("kb_text").eq("id", clientId).single(),
    db.from("kb_documents").select("id, title, status, source, version, updated_at").order("updated_at", { ascending: false }).limit(200),
    db.from("unanswered_questions").select("id, question, created_at").eq("status", "open").order("created_at", { ascending: false }).limit(50),
  ]);

  return (
    <section className="card">
      <h1>Knowledge base</h1>
      <Notice code={notice} why={why} />
      <p className="muted">The assistant answers ONLY from what is here. If something is missing it tells the customer it will check with the team.</p>

      <h2>Core knowledge (always included)</h2>
      <p className="muted">Keep this short: opening hours, headline prices, the facts customers ask about most. It is sent with every message.</p>
      <form action={updateKnowledge} className="stack">
        <textarea name="kb_text" maxLength={8000} defaultValue={client?.kb_text ?? ""} />
        <div><button type="submit">Save core knowledge</button></div>
      </form>

      <h2>Documents</h2>
      <p className="muted">Longer material (price lists, policies, FAQs). For each question the assistant looks up only the most relevant parts. Use headings (# Title) to keep topics separate.</p>
      <table>
        <thead><tr><th>Title</th><th>Status</th><th>Source</th><th>Version</th><th>Updated</th></tr></thead>
        <tbody>
          {(docs ?? []).map((d) => (
            <tr key={d.id}>
              <td><Link href={`/dashboard/knowledge/documents/${d.id}`}>{d.title}</Link></td>
              <td><span className={`badge ${d.status === "active" ? "ok" : d.status === "draft" ? "human" : ""}`}>{d.status === "draft" ? "draft: needs your confirmation" : d.status}</span></td>
              <td>{d.source}</td><td>{d.version || "-"}</td><td>{fmt(d.updated_at)}</td>
            </tr>
          ))}
          {(docs ?? []).length === 0 && <tr><td colSpan={5} className="muted">No documents yet.</td></tr>}
        </tbody>
      </table>

      <h2 id="add-document">Add a document</h2>
      <form action={createDocument} className="stack">
        <label>Title (optional for files)<input name="title" maxLength={200} /></label>
        <label>Upload a file: PDF, DOCX or TXT (also .md), up to 2 MB
          <input name="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" />
        </label>
        <label>...or paste text<textarea name="text" style={{ minHeight: 160 }} maxLength={200000} /></label>
        <p className="muted">You will see the extracted text first and must confirm it before the assistant can use it.</p>
        <div><button type="submit">Continue to preview</button></div>
      </form>

      <h2>Questions the assistant couldn&apos;t answer</h2>
      <p className="muted">Add the answer to your knowledge base, then mark the question done.</p>
      <table>
        <thead><tr><th>Question</th><th>Asked</th><th></th></tr></thead>
        <tbody>
          {(questions ?? []).map((q) => (
            <tr key={q.id}>
              <td>{q.question}</td><td>{fmt(q.created_at)}</td>
              <td><div className="row">
                {(["resolved", "dismissed"] as const).map((s) => (
                  <form key={s} action={resolveQuestion}>
                    <input type="hidden" name="id" value={q.id} /><input type="hidden" name="status" value={s} />
                    <button className="secondary" type="submit">{s === "resolved" ? "I added the answer" : "Dismiss"}</button>
                  </form>
                ))}
              </div></td>
            </tr>
          ))}
          {(questions ?? []).length === 0 && <tr><td colSpan={3} className="muted">None right now.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
