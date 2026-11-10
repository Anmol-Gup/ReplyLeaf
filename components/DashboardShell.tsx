"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "./Icon";
import Logo from "./Logo";
import SubmitButton from "./SubmitButton";
import { PRODUCT_NAME } from "../lib/brand";

// Sidebar on desktop, a menu button + dropdown on phones. Navigation only:
// the same routes as before, no data access here.
const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: "/dashboard", label: "Overview", icon: "home" },
  { href: "/dashboard/conversations", label: "Conversations", icon: "chat" },
  { href: "/dashboard/contacts", label: "Contacts", icon: "users" },
  { href: "/dashboard/knowledge", label: "Knowledge base", icon: "book" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings" },
  { href: "/dashboard/usage", label: "Usage", icon: "chart" },
];

function Nav({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  const items = isAdmin ? [...ITEMS, { href: "/admin/signups", label: "Admin: sign-ups", icon: "shield" as IconName }] : ITEMS;
  return (
    <nav className="nav" aria-label="Main">
      {items.map((i) => {
        const active = i.href === "/dashboard" ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
            <Icon name={i.icon} /> {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function DashboardShell({
  businessName, signOut, isAdmin = false, children,
}: { businessName: string; signOut: () => Promise<void>; isAdmin?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]); // close the phone menu after navigating

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><Logo size={34} /> {PRODUCT_NAME}</Link>
        <Nav pathname={pathname} isAdmin={isAdmin} />
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <button
              type="button" className="btn btn-secondary btn-sm menu-button" aria-expanded={open} aria-controls="mobile-nav"
              onClick={() => setOpen((o) => !o)}
            >
              <Icon name={open ? "x" : "menu"} /> <span>Menu</span>
            </button>
            <span className="who" title={businessName}>{businessName}</span>
          </div>
          <form action={signOut}>
            <SubmitButton variant="secondary" small pendingText="Signing out..."><Icon name="logout" size={16} /> Sign out</SubmitButton>
          </form>
        </header>
        <div id="mobile-nav" className="mobile-nav" hidden={!open}><Nav pathname={pathname} isAdmin={isAdmin} /></div>
        <main id="main" className="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
