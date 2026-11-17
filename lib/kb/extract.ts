import { inflateRawSync, inflateSync } from "node:zlib";
import { MAX_DOC_CHARS } from "./chunk";

// Text extraction for uploads, written with node:zlib only (no extra packages).
// The owner ALWAYS sees the extracted text in a preview and must confirm it, so
// a poor extraction can never silently end up in the knowledge base.
//
//   .txt / .md : decoded as UTF-8
//   .docx      : unzip word/document.xml, keep headings, lists and paragraphs
//   .pdf       : BEST EFFORT for simple text PDFs. Scanned PDFs (images) and many
//                PDFs exported from Word/Google Docs (custom font encodings) cannot
//                be read this way; we detect that and ask the owner to paste text.

// Messages are fixed strings looked up by code, so the dashboard can show them
// from a URL parameter without ever echoing arbitrary text from the URL.
export const EXTRACT_MESSAGES = {
  empty: "The file is empty.",
  too_large: "The file is larger than 10 MB.",
  unsupported: "Unsupported file type. Use .txt, .md, .docx or a text PDF, or paste the text.",
  unreadable: "This file could not be read. Try pasting the text instead.",
  no_text: "No text was found in this file.",
  too_long: "The text is too long (limit 200,000 characters). Split it into several documents.",
  binary: "This looks like a binary file, not text.",
  not_utf8: "The file is not valid UTF-8 text. Save it as UTF-8, or paste the text.",
  not_docx: "This does not look like a Word (.docx) document.",
  not_pdf: "This does not look like a PDF.",
  pdf_unreadable: "No readable text could be extracted from this PDF (it may be scanned, or use a font encoding this reader does not support). Paste the text instead, or export it as .txt or .docx.",
} as const;

export class ExtractError extends Error {
  constructor(readonly code: keyof typeof EXTRACT_MESSAGES) {
    super(EXTRACT_MESSAGES[code]);
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INFLATED = 20 * 1024 * 1024; // zip-bomb guard

export type Extracted = { text: string; source: "txt" | "md" | "docx" | "pdf" };

export function extractText(filename: string, bytes: Buffer): Extracted {
  if (bytes.length === 0) throw new ExtractError("empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ExtractError("too_large");
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  let text: string;
  let source: Extracted["source"];
  try {
    if (ext === "txt" || ext === "md" || ext === "markdown") {
      source = ext === "txt" ? "txt" : "md";
      text = decodeUtf8(bytes);
    } else if (ext === "docx") {
      source = "docx";
      text = extractDocx(bytes);
    } else if (ext === "pdf") {
      source = "pdf";
      text = extractPdf(bytes);
    } else {
      throw new ExtractError("unsupported");
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("unreadable");
  }

  text = tidy(text);
  if (!text) throw new ExtractError("no_text");
  if (text.length > MAX_DOC_CHARS) throw new ExtractError("too_long");
  return { text, source };
}

const tidy = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function decodeUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ExtractError("binary");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new ExtractError("not_utf8");
  }
}

// ------------------------------------------------------------------- .docx
export function extractDocx(bytes: Buffer): string {
  const xml = readZipEntry(bytes, "word/document.xml");
  if (!xml) throw new ExtractError("not_docx");
  return docxXmlToText(xml.toString("utf8"));
}

/** Minimal ZIP reader: finds one entry via the central directory. */
export function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_INFLATED });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

export function docxXmlToText(xml: string): string {
  const lines: string[] = [];
  for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    let text = "";
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
      text += m[1] !== undefined ? decodeXml(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n";
    }
    if (!text.trim()) { lines.push(""); continue; }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(para)?.[1] ?? "";
    const heading = /^heading\s*(\d)$/i.exec(style);
    if (heading) lines.push(`${"#".repeat(Math.min(4, Number(heading[1])))} ${text.trim()}`);
    else if (/^title$/i.test(style)) lines.push(`# ${text.trim()}`);
    else if (/<w:numPr>/.test(para)) lines.push(`- ${text.trim()}`);
    else lines.push(text.trim());
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------- .pdf
export function extractPdf(buf: Buffer): string {
  if (!buf.subarray(0, 8).toString("latin1").includes("%PDF")) throw new ExtractError("not_pdf");
  const raw = buf.toString("latin1");
  const pages: string[] = [];

  let idx = 0;
  while ((idx = raw.indexOf("stream", idx)) !== -1) {
    if (raw.startsWith("endstream", idx - 3)) { idx += 6; continue; }
    let start = idx + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const dict = raw.slice(Math.max(0, raw.lastIndexOf("obj", idx)), idx);
    let data: Buffer | null = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data, { maxOutputLength: MAX_INFLATED }); } catch { data = null; }
    } else if (/\/Filter/.test(dict)) {
      data = null; // some other encoding we do not decode
    }
    if (data) {
      const content = data.toString("latin1");
      if (/\bBT\b/.test(content) && /\bET\b/.test(content)) pages.push(pdfContentToText(content));
    }
    idx = end + 9;
  }

  const text = tidy(pages.join("\n\n"));
  // Quality gate: custom font encodings produce gibberish, not words.
  const printable = [...text].filter((c) => /[\x20-\x7e\n\t -ÿ]/.test(c)).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (text.length < 20 || printable / text.length < 0.9 || letters / text.length < 0.4) {
    throw new ExtractError("pdf_unreadable");
  }
  return text;
}

const TOKEN = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|[-+]?\d*\.?\d+|\/[^\s/[\]()<>]+|[A-Za-z'"*]+/g;

function pdfContentToText(content: string): string {
  let out = "";
  // Real strings are the only `string` operands; array brackets and names are
  // separate object types so a text string like "[" can never be mistaken for one.
  let operands: (string | number | { mark: "[" | "]" | "name" })[] = [];
  let lastY: number | null = null;

  for (const [tok] of content.matchAll(TOKEN)) {
    const c = tok[0];
    if (c === "(") { operands.push(unescapePdfString(tok.slice(1, -1))); continue; }
    if (c === "<") { operands.push(hexToString(tok.slice(1, -1))); continue; }
    if (tok === "[" || tok === "]") { operands.push({ mark: tok }); continue; }
    if (c === "/") { operands.push({ mark: "name" }); continue; }
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { operands.push(Number(tok)); continue; }

    // an operator: act on the collected operands, then reset them
    const nums = operands.filter((o): o is number => typeof o === "number");
    switch (tok) {
      case "Tj": out += operands.filter((o): o is string => typeof o === "string").join(""); break;
      case "'": case '"': out += "\n" + operands.filter((o): o is string => typeof o === "string").join(""); break;
      case "TJ": {
        for (const o of operands) {
          if (typeof o === "string") out += o;
          else if (typeof o === "number" && o < -200) out += " "; // big kerning gap = a space
        }
        break;
      }
      case "Td": case "TD": if (nums.length >= 2 && nums[nums.length - 1] !== 0) out += "\n"; break;
      case "T*": out += "\n"; break;
      case "Tm": {
        const y = nums[nums.length - 1];
        if (nums.length >= 6 && lastY !== null && Math.abs(y - lastY) > 1) out += "\n";
        if (nums.length >= 6) lastY = y;
        break;
      }
      case "ET": out += "\n"; break;
    }
    operands = [];
  }
  return out;
}

function unescapePdfString(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    if (e === "n") return "\n";
    if (e === "r") return "\r";
    if (e === "t") return "\t";
    if (e === "b") return "\b";
    if (e === "f") return "\f";
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    if (e === "(" || e === ")" || e === "\\") return e;
    return ""; // escaped line break
  });
}

function hexToString(hex: string): string {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
}
