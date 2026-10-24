import { aiConfig } from "../ai/config";
import { supabaseAdmin } from "../supabase-admin";
import { chunkText, MAX_DOC_CHARS } from "./chunk";
import { asDocument, embedTexts, EMBEDDING_MODEL } from "./embed";

// Turns document text into searchable chunks (with embeddings when possible).
// If the embedding service fails the chunks are still stored WITHOUT vectors,
// so keyword search keeps working; the owner is told and can re-index later.
export async function buildChunks(title: string, content: string) {
  if (content.length > MAX_DOC_CHARS) throw new Error("document too long");
  const chunks = chunkText(content);
  let vectors: number[][] | null = null;
  try {
    vectors = await embedTexts(chunks.map((c) => asDocument(title, c.content)), aiConfig().geminiApiKey);
  } catch (e) {
    console.error("embedding failed, storing chunks without vectors", e instanceof Error ? e.message : e);
  }
  return {
    embedded: vectors !== null,
    payload: chunks.map((c, i) => ({
      heading: c.heading, content: c.content,
      embedding: vectors ? vectors[i] : null, model: vectors ? EMBEDDING_MODEL : null,
    })),
  };
}

export async function publishDocument(clientId: string, documentId: string, title: string, content: string, userId: string) {
  const { payload, embedded } = await buildChunks(title, content);
  const { data, error } = await supabaseAdmin().rpc("save_document_version", {
    p_client_id: clientId, p_document_id: documentId, p_title: title, p_content: content,
    p_user_id: userId, p_chunks: payload,
  });
  if (error) throw new Error(`publishing failed: ${error.message}`);
  return { version: data as number, chunks: payload.length, embedded };
}

/** Re-run chunking + embedding for the current text without creating a new version. */
export async function reindexDocument(clientId: string, documentId: string) {
  const db = supabaseAdmin();
  const { data: doc } = await db.from("kb_documents").select("title, content, status")
    .eq("id", documentId).eq("client_id", clientId).maybeSingle();
  if (!doc || doc.status !== "active") throw new Error("only active documents can be re-indexed");
  const { payload, embedded } = await buildChunks(doc.title, doc.content);
  const { error } = await db.rpc("replace_document_chunks", { p_client_id: clientId, p_document_id: documentId, p_chunks: payload });
  if (error) throw new Error(`re-index failed: ${error.message}`);
  return { chunks: payload.length, embedded };
}
