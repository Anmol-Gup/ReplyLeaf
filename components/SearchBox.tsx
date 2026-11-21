"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { searchHref } from "../lib/filters";
import Icon from "./Icon";

// The search box on the list pages. Pressing Search updates the list in place (no browser reload), keeps the filters you chose
// (status, priority and so on), and starts again from page 1. Without JavaScript it is still a plain GET form.
export default function SearchBox({ q, placeholder, keep = {} }: { q?: string; placeholder: string; keep?: Record<string, string | string[] | undefined> }) {
  const router = useRouter();
  const path = usePathname();
  const [value, setValue] = useState(q ?? "");
  const [pending, start] = useTransition();
  useEffect(() => setValue(q ?? ""), [q]); // the page answered (or a filter was reset): show what it is now searching for
  return (
    <form method="get" role="search" className="search" onSubmit={(e) => { e.preventDefault(); start(() => router.push(searchHref(path, value, keep))); }}>
      {Object.entries(keep).flatMap(([k, v]) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => <input key={`${k}-${x}`} type="hidden" name={k} value={x} />))}
      <Icon name="search" size={16} />
      <input name="q" type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <button className="btn btn-secondary btn-sm" type="submit" disabled={pending} aria-busy={pending}>
        {pending && <span className="spinner" aria-hidden="true" />}{pending ? "Searching..." : "Search"}
      </button>
    </form>
  );
}
