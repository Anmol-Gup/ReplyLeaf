"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { searchHref } from "../lib/filters";
import Icon from "./Icon";

// The search box on the list pages. Typing (after a short pause) or pressing Enter updates the list in place (no browser reload), keeps the filters you chose
// (status, priority and so on), and starts again from page 1. Without JavaScript it is still a plain GET form.
export default function SearchBox({ q, placeholder, keep = {}, live = true }: { q?: string; placeholder: string; keep?: Record<string, string | string[] | undefined>; live?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [value, setValue] = useState(q ?? "");
  const [pending, start] = useTransition();
  const edited = useRef(0);
  // Do not overwrite what is being typed with an older answer that arrives late.
  useEffect(() => { if (!live || Date.now() - edited.current > 1500) setValue(q ?? ""); }, [q, live]); // the page answered (or a filter was reset): show what it is now searching for
  // live: search as you type (after a short pause) and no button, like the Conversations list.
  useEffect(() => {
    if (!live || value === (q ?? "")) return;
    const t = setTimeout(() => start(() => router.replace(searchHref(path, value, keep))), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, live]);
  return (
    <form method="get" role="search" className="search" onSubmit={(e) => { e.preventDefault(); start(() => router.push(searchHref(path, value, keep))); }}>
      {Object.entries(keep).flatMap(([k, v]) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => <input key={`${k}-${x}`} type="hidden" name={k} value={x} />))}
      <Icon name="search" size={16} />
      <input name="q" type="search" value={value} onChange={(e) => { edited.current = Date.now(); setValue(e.target.value); }} placeholder={placeholder} aria-label={placeholder} />
      {!live && <button className="btn btn-secondary btn-sm" type="submit" disabled={pending} aria-busy={pending}>
        {pending && <span className="spinner" aria-hidden="true" />}{pending ? "Searching..." : "Search"}
      </button>}
    </form>
  );
}
