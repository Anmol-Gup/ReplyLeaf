"use client";

import { useEffect } from "react";

// A message such as "Note added." arrives in the address (?notice=...). Once it has been shown, take it out of the address,
// so reloading the page doesn't show it again. Nothing is refetched: only the address bar changes.
export default function NoticeCleaner() {
  useEffect(() => {
    // Next.js writes the new address into the history itself right after a redirect (after this effect runs), which would put the
    // message back, so the clean-up waits a moment and then runs.
    const clean = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("notice") && !url.searchParams.has("why")) return;
      url.searchParams.delete("notice");
      url.searchParams.delete("why");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    };
    const timers = [setTimeout(clean, 0), setTimeout(clean, 300)];
    return () => timers.forEach(clearTimeout);
  }, []);
  return null;
}
