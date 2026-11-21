"use client";

// A form that asks "Are you sure?" before it submits (used for permanent deletes). Cancelling sends nothing.
export default function ConfirmForm({ action, message, children, className }: { action: (formData: FormData) => void | Promise<void>; message: string; children: React.ReactNode; className?: string }) {
  return <form action={action} className={className} onSubmit={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>{children}</form>;
}
