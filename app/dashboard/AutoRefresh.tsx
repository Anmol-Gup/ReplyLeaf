"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-fetches the server data every few seconds so new messages appear without a manual reload.
export default function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
