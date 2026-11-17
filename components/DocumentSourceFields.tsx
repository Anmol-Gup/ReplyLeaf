"use client";

import { useState } from "react";
import Icon from "./Icon";

// "Add a document": choose how to provide it (upload a file or paste text) and only that input is shown.
// The unused input is removed from the form, so a leftover file or text can never be sent by accident.
// The server action is unchanged (it takes `file` or `text`, and checks them again).
export default function DocumentSourceFields({ maxTextChars }: { maxTextChars: number }) {
  const [mode, setMode] = useState<"file" | "text">("file");
  return (
    <>
      <label className="field">How do you want to add it?
        <select value={mode} onChange={(e) => setMode(e.target.value as "file" | "text")}>
          <option value="file">Upload a file</option>
          <option value="text">Paste text</option>
        </select>
      </label>
      {mode === "file" ? (
        <label className="field"><span><Icon name="upload" size={15} /> File</span>
          <span className="hint">PDF, DOCX, TXT or MD, up to 10 MB</span>
          <input name="file" type="file" required accept=".pdf,.docx,.txt,.md,.markdown" />
        </label>
      ) : (
        <label className="field">Text <span className="hint">Use # headings to keep topics separate.</span>
          <textarea name="text" required style={{ minHeight: 160 }} maxLength={maxTextChars} />
        </label>
      )}
    </>
  );
}
