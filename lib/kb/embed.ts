import { GoogleGenAI } from "@google/genai";

// Embeddings use ONE model for every client (so vectors are comparable no
// matter which chat provider a client picks): Gemini `gemini-embedding-2`,
// 768 dimensions. That model has no taskType option; Google's docs say to put
// the task in the text instead, which is what the two helpers below do.
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 768;
const BATCH = 16;

export const asDocument = (title: string | null, content: string) => `title: ${title || "none"} | text: ${content}`;
export const asQuery = (query: string) => `task: search result | query: ${query}`;

/** One vector per input text, in order. Throws on any failure; callers decide the fallback. */
export async function embedTexts(texts: string[], apiKey: string | undefined): Promise<number[][]> {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (needed for embeddings)");
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 25_000 } });
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    // Each text in its own Content object, otherwise the model returns ONE aggregated vector.
    const res = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch.map((t) => ({ parts: [{ text: t }] })),
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    const got = res.embeddings ?? [];
    if (got.length !== batch.length) throw new Error(`embedding count mismatch: sent ${batch.length}, got ${got.length}`);
    for (const e of got) {
      if (!e.values || e.values.length !== EMBEDDING_DIMENSIONS) throw new Error("unexpected embedding size");
      vectors.push(e.values);
    }
  }
  return vectors;
}
