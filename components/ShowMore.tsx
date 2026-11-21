"use client";

import { Children, useState } from "react";

// A list that shows the latest few and lets you reveal more, a few at a time, then collapse back. Keeps long histories from stretching a page.
export default function ShowMore({ children, initial = 5, step = 5, className = "latest compact", noun = "item", plain = false }: { plain?: boolean; children: React.ReactNode; initial?: number; step?: number; className?: string; noun?: string }) {
  const items = Children.toArray(children);
  const [shown, setShown] = useState(initial);
  const hidden = Math.max(0, items.length - shown);
  return (
    <>
      {plain ? <div>{items.slice(0, shown)}</div> : <ul className={className}>{items.slice(0, shown)}</ul>}
      {items.length > initial && (
        <div className="show-more">
          {hidden > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown((s) => s + step)}>Show {Math.min(step, hidden)} more {noun}{Math.min(step, hidden) === 1 ? "" : "s"} <span className="muted">({hidden} left)</span></button>}
          {shown > initial && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(initial)}>Show less</button>}
        </div>
      )}
    </>
  );
}
