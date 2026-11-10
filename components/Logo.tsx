"use client";

import { useEffect, useRef, useState } from "react";

// Shows /public/replyleaf/mark.svg. Until that file exists (or if it fails to load) a purple
// "R" mark is shown instead, so there is never a broken-image icon.
// The check on mount matters: the browser can report the load failure BEFORE React
// has attached onError, so we also look at the image's state once hydrated.
export default function Logo({ size = 36 }: { size?: number }) {
  const [broken, setBroken] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setBroken(true);
  }, []);

  if (broken) {
    return <span className="logo-mark" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">R</span>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} src="/replyleaf/mark.svg" alt="Replyleaf logo" width={size} height={size} className="logo-img" onError={() => setBroken(true)} />;
}
