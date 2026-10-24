"use client";

import { useEffect, useRef } from "react";

// The message list. Starts scrolled to the newest message, and follows new ones
// only if the reader was already at the bottom (so reading history isn't interrupted).
export default function ChatLog({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      ref={ref} className="chat-log" role="log" aria-label="Messages" tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {children}
    </div>
  );
}
