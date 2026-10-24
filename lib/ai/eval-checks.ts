import type { ReplyResult } from "./schema";

// Heuristic pass/fail checks for the sample questions. They catch obvious
// failures (invented prices, wrong intent, leaked prompt); a human should still
// skim the replies, since wording varies between models.

export type Expectation = {
  intent?: ReplyResult["intent"];
  answered?: boolean;
  includes?: string[]; // ALL must appear
  anyOf?: string[]; // at least one must appear
  excludes?: string[]; // NONE may appear
};

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

export function checkReply(reply: ReplyResult, expect: Expectation): string[] {
  const text = norm(reply.reply);
  const problems: string[] = [];
  if (expect.intent && reply.intent !== expect.intent) problems.push(`intent was "${reply.intent}", expected "${expect.intent}"`);
  if (expect.answered !== undefined && reply.answered !== expect.answered) problems.push(`answered was ${reply.answered}, expected ${expect.answered}`);
  for (const s of expect.includes ?? []) if (!text.includes(norm(s))) problems.push(`missing "${s}"`);
  if (expect.anyOf && !expect.anyOf.some((s) => text.includes(norm(s)))) problems.push(`none of: ${expect.anyOf.join(" | ")}`);
  for (const s of expect.excludes ?? []) if (text.includes(norm(s))) problems.push(`must not contain "${s}"`);
  return problems;
}
