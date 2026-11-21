import Icon from "./Icon";
import ShowMore from "./ShowMore";
import SubmitButton from "./SubmitButton";
import { shortName } from "../lib/notifications";
import { fmt } from "../lib/dashboard";

// Private notes on a record: add one, and read the newest first (three at a time, then "Show more"). Never shown to customers or used by
// the assistant. `earlier` is a single note written before dated notes existed.
export type NoteRow = { id: string; author_label: string | null; body: string; created_at: string };

export default function NotesCard({ action, id, notes, earlier }: { action: (formData: FormData) => void | Promise<void>; id: string; notes: NoteRow[]; earlier?: string | null }) {
  const rows: NoteRow[] = [...notes, ...(earlier ? [{ id: "earlier", author_label: null, body: earlier, created_at: "" }] : [])];
  return (
    <section className="card">
      <h2 className="rec-title">Notes</h2>
      <div className="rec-body">
        <p className="muted" style={{ marginTop: 0 }}>Private. Only your team sees these; they are never sent to the customer or used by the assistant.</p>
        <form action={action} className="stack-sm">
          <input type="hidden" name="id" value={id} />
          <label className="sr-only" htmlFor={`note-${id}`}>Add a note</label>
          <textarea id={`note-${id}`} name="body" required rows={2} maxLength={4000} placeholder="Add a note" />
          <div><SubmitButton small variant="secondary" pendingText="Adding...">Add note</SubmitButton></div>
        </form>
        {rows.length === 0 ? <p className="muted" style={{ marginBottom: 0 }}>No notes yet.</p> : (
          <div style={{ marginTop: 10 }}>
            <ShowMore plain initial={3} step={5} noun="note">
              {rows.map((n) => (
                <article key={n.id} className="rec-item">
                  <span className="rec-ico rec-lead"><Icon name="chat" size={16} /></span>
                  <div className="rec-main">
                    <p style={{ margin: 0, color: "var(--text)", whiteSpace: "pre-wrap" }}>{n.body}</p>
                    <p className="muted" style={{ margin: "4px 0 0" }}>{n.id === "earlier" ? "Earlier note (written before notes were dated)" : `${shortName(n.author_label) || "A team member"} · ${fmt(n.created_at)}`}</p>
                  </div>
                </article>
              ))}
            </ShowMore>
          </div>
        )}
      </div>
    </section>
  );
}
