"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Sends the person to `to` after `seconds` (they can also use the button on the page).
export default function RedirectAfter({ to, seconds }: { to: string; seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(() => router.replace(to), seconds * 1000);
    return () => clearTimeout(t);
  }, [router, to, seconds]);
  return null;
}
