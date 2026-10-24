import { aiConfig } from "../ai/config";
import { supabaseAdmin } from "../supabase-admin";
import { asQuery, embedTexts } from "./embed";

export type RetrievedChunk = { heading: string | null; content: string };

// Finds the chunks most relevant to what the customer just wrote, for ONE client.
// Never throws: if search fails the assistant still has the always-on core and
// will honestly say it will check with the team.
export async function retrieveKnowledge(clientId: string, customerText: string, limit = 6): Promise<RetrievedChunk[]> {
  const query = customerText.trim().slice(0, 500);
  if (!query) return [];
  try {
    let embedding: number[] | null = null;
    try {
      [embedding] = await embedTexts([asQuery(query)], aiConfig().geminiApiKey);
    } catch (e) {
      console.warn("query embedding failed, using full-text search only", e instanceof Error ? e.message : e);
    }
    const { data, error } = await supabaseAdmin().rpc("search_kb", {
      p_client_id: clientId, p_query: query, p_embedding: embedding, p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { out_heading: string | null; out_content: string }[])
      .map((r) => ({ heading: r.out_heading, content: r.out_content }));
  } catch (e) {
    console.error("knowledge search failed", e instanceof Error ? e.message : e);
    return [];
  }
}
