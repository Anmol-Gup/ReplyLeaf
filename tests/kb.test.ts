import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import { chunkText, MAX_CHUNK_CHARS } from "../lib/kb/chunk";
import { asDocument, asQuery } from "../lib/kb/embed";
import { docxXmlToText, ExtractError, extractText, MAX_UPLOAD_BYTES } from "../lib/kb/extract";

// ---------------------------------------------------------------- chunking
test("chunks by headings and keeps the heading path in each chunk", () => {
  const chunks = chunkText("# Policies\n\n## Cancellations\nGive 24 hours notice.\n\n## Payment\nCash or card.\n\n# Prices\nCleaning $60");
  assert.deepEqual(chunks.map((c) => c.heading), ["Policies > Cancellations", "Policies > Payment", "Prices"]);
  assert.match(chunks[0].content, /^Policies > Cancellations\nGive 24 hours notice\./);
});

test("text without headings is still chunked, and empty sections are skipped", () => {
  assert.deepEqual(chunkText("just a line").map((c) => c.heading), [null]);
  assert.equal(chunkText("# Empty\n\n# Also empty").length, 0);
  assert.equal(chunkText("").length, 0);
});

test("long sections are split under the size limit without losing text", () => {
  const para = (n: number) => `Sentence ${n}. `.repeat(60).trim();
  const text = "# Big\n" + Array.from({ length: 8 }, (_, i) => para(i)).join("\n\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.content.length <= MAX_CHUNK_CHARS + 10, `${c.content.length}`);
  assert.ok(chunks.every((c) => c.heading === "Big"));
  assert.equal(chunks.map((c) => c.content).join(" ").match(/Sentence 7/g)?.length! > 0, true);
});

test("a single huge unbroken paragraph is hard-split", () => {
  const chunks = chunkText("word ".repeat(2000));
  assert.ok(chunks.length >= 8);
  for (const c of chunks) assert.ok(c.content.length <= MAX_CHUNK_CHARS + 10);
});

test("heading levels pop correctly", () => {
  const chunks = chunkText("# A\n## B\nb text\n# C\nc text");
  assert.deepEqual(chunks.map((c) => c.heading), ["A > B", "C"]);
});

test("embedding inputs follow the gemini-embedding-2 text conventions", () => {
  assert.equal(asQuery("price?"), "task: search result | query: price?");
  assert.equal(asDocument("Prices", "x"), "title: Prices | text: x");
  assert.equal(asDocument(null, "x"), "title: none | text: x");
});

// ------------------------------------------------------------- text files
test("txt and md are decoded as UTF-8", () => {
  assert.deepEqual(extractText("a.txt", Buffer.from("Héllo\r\nwörld")), { text: "Héllo\nwörld", source: "txt" });
  assert.equal(extractText("a.MD", Buffer.from("# T\nx")).source, "md");
});

test("bad uploads are rejected with a stable error code", () => {
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ExtractError ? e.code : "other"; } return "none"; };
  assert.equal(code(() => extractText("a.txt", Buffer.alloc(0))), "empty");
  assert.equal(code(() => extractText("a.txt", Buffer.alloc(MAX_UPLOAD_BYTES + 1, 97))), "too_large");
  assert.equal(code(() => extractText("a.exe", Buffer.from("x"))), "unsupported");
  assert.equal(code(() => extractText("a.txt", Buffer.from([0x61, 0x00, 0x62]))), "binary");
  assert.equal(code(() => extractText("a.txt", Buffer.from([0xff, 0xfe, 0xfd]))), "not_utf8");
  assert.equal(code(() => extractText("a.txt", Buffer.from("   \n  "))), "no_text");
  assert.equal(code(() => extractText("a.docx", Buffer.from("not a zip"))), "not_docx");
  assert.equal(code(() => extractText("a.pdf", Buffer.from("not a pdf"))), "not_pdf");
});

// -------------------------------------------------------------------- docx
function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
// Builds a real zip file in memory so the reader is tested against the actual format.
function makeZip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docXml = `<?xml version="1.0"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Price list</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Cleaning costs </w:t></w:r><w:r><w:t>$60 &amp; up</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Free parking</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Hours</w:t></w:r></w:p>
<w:p><w:r><w:t>Mon</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>9-5</w:t></w:r></w:p>
</w:body></w:document>`;

test("docx: headings, lists, entities and tabs survive extraction", () => {
  const out = extractText("menu.docx", makeZip({ "[Content_Types].xml": "<x/>", "word/document.xml": docXml }));
  assert.equal(out.source, "docx");
  assert.match(out.text, /^# Price list\nCleaning costs \$60 & up\n- Free parking\n## Hours\nMon\t9-5$/);
  // and it feeds straight into the heading-based chunker
  assert.deepEqual(chunkText(out.text).map((c) => c.heading), ["Price list", "Price list > Hours"]);
});

test("docx: stored (uncompressed) entries work, other zips are rejected", () => {
  assert.match(extractText("a.docx", makeZip({ "word/document.xml": docXml }, 0)).text, /Price list/);
  assert.throws(() => extractText("a.docx", makeZip({ "other.xml": "<x/>" })), (e: unknown) => e instanceof ExtractError && e.code === "not_docx");
});

test("docx xml helper decodes numeric entities", () => {
  assert.equal(docxXmlToText(`<w:p><w:r><w:t>caf&#233; &#x41;</w:t></w:r></w:p>`), "café A");
});

// --------------------------------------------------------------------- pdf
function makePdf(content: string, compress: boolean): Buffer {
  const body = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = compress ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n4 0 obj\n<< /Length " + body.length + filter + " >>\nstream\n", "latin1"),
    body, Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "latin1"),
  ]);
}
const pageContent = "BT /F1 12 Tf 72 700 Td (Opening hours: Mon-Fri 9 to 6) Tj 0 -20 Td [(Cleaning costs ) -300 ($60 \\(adult\\))] TJ ET";

test("pdf: reads text from simple (compressed or plain) text PDFs", () => {
  for (const compress of [true, false]) {
    const out = extractText("a.pdf", makePdf(pageContent, compress));
    assert.equal(out.source, "pdf");
    assert.match(out.text, /Opening hours: Mon-Fri 9 to 6\nCleaning costs\s+\$60 \(adult\)/);
  }
});

test("pdf: gibberish or image-only PDFs are refused, not stored", () => {
  const garbage = "BT /F1 12 Tf <0102030405060708090A0B0C0D0E0F101112131415> Tj ET";
  assert.throws(() => extractText("a.pdf", makePdf(garbage, true)), (e: unknown) => e instanceof ExtractError && e.code === "pdf_unreadable");
  assert.throws(() => extractText("a.pdf", makePdf("q 100 0 0 100 0 0 cm /Im0 Do Q", true)), (e: unknown) => e instanceof ExtractError && e.code === "pdf_unreadable");
});
