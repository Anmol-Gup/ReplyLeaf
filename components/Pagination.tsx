import Link from "next/link";
import type { Page } from "../lib/paginate";

// Previous / Next with a "Showing 11-20 of 43" summary. Plain links, so it works without
// JavaScript and keeps the other filters through `hrefFor`. Renders nothing for a single page.
export default function Pagination({ p, hrefFor, label }: { p: Pick<Page<unknown>, "page" | "pages" | "total" | "from" | "to">; hrefFor: (page: number) => string; label: string }) {
  if (p.pages <= 1) return null;
  return (
    <nav className="pagination" aria-label={`${label} pages`}>
      <span aria-live="polite">Showing {p.from}-{p.to} of {p.total}</span>
      <div className="row">
        {p.page > 1
          ? <Link className="btn btn-secondary btn-sm" href={hrefFor(p.page - 1)} rel="prev">Previous</Link>
          : <span className="btn btn-secondary btn-sm is-disabled" aria-disabled="true">Previous</span>}
        <span>Page {p.page} of {p.pages}</span>
        {p.page < p.pages
          ? <Link className="btn btn-secondary btn-sm" href={hrefFor(p.page + 1)} rel="next">Next</Link>
          : <span className="btn btn-secondary btn-sm is-disabled" aria-disabled="true">Next</span>}
      </div>
    </nav>
  );
}
