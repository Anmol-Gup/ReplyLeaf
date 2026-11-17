"use client";

import { useId, useRef } from "react";

// A searchable time zone picker: type "kol" and the list narrows to Asia/Kolkata. It is the browser's own filtered
// list (no extra package). The field is still a normal form field named `name`; only zones from the list are accepted
// (an empty field means "not set"), and the server checks the value again.
export default function TimezoneSelect({ name, zones, defaultValue }: { name: string; zones: string[]; defaultValue: string | null }) {
  const listId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const check = () => {
    const el = ref.current;
    if (!el) return;
    el.setCustomValidity(el.value === "" || zones.includes(el.value) ? "" : "Choose a time zone from the list, for example Asia/Kolkata.");
  };
  return (
    <>
      <input ref={ref} name={name} list={listId} defaultValue={defaultValue ?? ""} placeholder="Not set. Type to search, e.g. Kolkata"
        autoComplete="off" spellCheck={false} maxLength={60} onInput={check} onBlur={check} />
      <datalist id={listId}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
    </>
  );
}
