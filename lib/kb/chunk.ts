// Splits knowledge text into chunks for search. Markdown headings are the
// primary boundary, so one chunk stays about one topic ("Policies > Cancellations").
// Each chunk's text starts with its heading path, which helps both full-text
// and vector search find it.

export type Chunk = { heading: string | null; content: string };

export const MAX_CHUNK_CHARS = 1200;
export const MAX_DOC_CHARS = 200_000;
export const MAX_CHUNKS = 300;

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const stack: { level: number; title: string }[] = [];
  const out: Chunk[] = [];
  let body: string[] = [];

  const flush = () => {
    const path = stack.map((s) => s.title).join(" > ") || null;
    const text = body.join("\n").trim();
    body = [];
    if (!text) return; // heading with nothing under it
    for (const piece of splitLong(text, maxChars)) {
      out.push({ heading: path, content: path ? `${path}\n${piece}` : piece });
    }
  };

  for (const line of lines) {
    const m = HEADING.exec(line);
    if (!m) {
      body.push(line);
      continue;
    }
    flush();
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: m[2] });
  }
  flush();
  return out.slice(0, MAX_CHUNKS);
}

// Long sections are cut at paragraph boundaries, then sentence/word boundaries.
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let current = "";
  const push = (s: string) => {
    if (current && current.length + s.length + 2 > maxChars) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${s}` : s;
  };
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= maxChars) push(para.trim());
    else for (const part of hardSplit(para, maxChars)) push(part);
  }
  if (current) pieces.push(current);
  return pieces.filter(Boolean);
}

function hardSplit(s: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = s.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > maxChars * 0.4 ? cut + 1 : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
