"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { parseAuthHash } from "../lib/auth-links";

// Catches old-style confirmation links that land on any page with a #fragment, strips the
// fragment from the address bar and history (it contains a login token we do not use),
// and shows the proper result page instead.
export default function AuthHashHandler() {
  const router = useRouter();
  useEffect(() => {
    const result = parseAuthHash(window.location.hash);
    if (!result) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    router.replace(result === "verified" ? "/verified" : `/verified?error=${result}`);
  }, [router]);
  return null;
}
