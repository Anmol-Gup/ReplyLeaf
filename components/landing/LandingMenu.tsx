"use client";

import { useEffect, useState } from "react";
import Icon from "../Icon";

type MenuLink = { href: string; label: string };

// Mobile navigation. A real button + panel (not hover), closes on Escape and after a link is chosen.
export default function LandingMenu({ links, signInHref, ctaHref, ctaLabel }: { links: MenuLink[]; signInHref: string; ctaHref: string; ctaLabel: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lp-menu">
      <button type="button" className="lp-menu-btn" aria-expanded={open} aria-controls="lp-menu-panel" onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "x" : "menu"} size={22} />
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
      </button>
      {open && (
        <nav id="lp-menu-panel" className="lp-menu-panel" aria-label="Mobile">
          {links.map((l) => <a key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</a>)}
          <a href={signInHref} onClick={() => setOpen(false)}>Sign in</a>
          <a href={ctaHref} className="btn btn-primary" onClick={() => setOpen(false)}>{ctaLabel}</a>
        </nav>
      )}
    </div>
  );
}
