"use client";

import { useRef, useState } from "react";
import Icon from "./Icon";

// "Add a document": two tabs (Upload file / Paste text); only the chosen input is in the form, so a leftover file or text is never sent.
// The server action is unchanged (it takes `file` or `text`, and checks them again). The title comes after, so users first choose how.
export default function DocumentSourceFields({ maxTextChars, maxMb }: { maxTextChars: number; maxMb: number }) {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [over, setOver] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tooBig = () => { const f = input.current?.files?.[0]; return !!f && f.size > maxMb * 1024 * 1024; };
  return (
    <>
      <div className="tabs" role="tablist" aria-label="How to add the document">
        {(["file", "text"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`tab${mode === m ? " active" : ""}`} onClick={() => setMode(m)}>
            {m === "file" ? "Upload file" : "Paste text"}
          </button>
        ))}
      </div>
      {mode === "file" ? (
        <div className={`dropzone${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setOver(false);
            if (input.current && e.dataTransfer.files.length) { input.current.files = e.dataTransfer.files; setName(e.dataTransfer.files[0].name); }
          }}>
          <Icon name="upload" size={22} />
          <p><b>Drag and drop a file here</b>, or</p>
          <label className="btn btn-secondary btn-sm">Choose file
            <input ref={input} name="file" type="file" required accept=".pdf,.docx,.txt,.md,.markdown" className="sr-only"
              onChange={(e) => { setName(e.target.files?.[0]?.name ?? ""); e.target.setCustomValidity(tooBig() ? `This file is over ${maxMb} MB.` : ""); }} />
          </label>
          <p className="muted">{name || `PDF, DOCX, TXT or MD, up to ${maxMb} MB`}</p>
        </div>
      ) : (
        <label className="field">Text <span className="hint">Use # headings to keep topics separate.</span>
          <textarea name="text" required style={{ minHeight: 160 }} maxLength={maxTextChars} />
        </label>
      )}
    </>
  );
}
