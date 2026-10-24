// Runs the 20 sample questions against Gemini and/or OpenAI and prints a report.
//
//   npm run eval                          # both providers (those with a key)
//   npm run eval -- --provider gemini
//   npm run eval -- --only q09-unknown-implants,q15-wants-human
//
// Uses eval/sample-kb.md as the knowledge base. Needs only the AI keys in .env
// (no database). Real API calls: each run costs a few cents at most.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aiConfig } from "../lib/ai/config";
import { checkReply, type Expectation } from "../lib/ai/eval-checks";
import { generateReply } from "../lib/ai/generate-reply";
import { buildSystemPrompt, wrapCustomerMessages } from "../lib/ai/prompt";
import type { Provider } from "../lib/ai/providers";

type Question = { id: string; kind: string; question: string; bookingLink?: string; expect: Expectation };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const config = aiConfig();
  const kb = readFileSync(join(process.cwd(), "eval/sample-kb.md"), "utf8");
  let questions: Question[] = JSON.parse(readFileSync(join(process.cwd(), "eval/questions.json"), "utf8"));
  const only = arg("only")?.split(",");
  if (only) questions = questions.filter((q) => only.includes(q.id));

  const wanted = (arg("provider") ?? "both") as Provider | "both";
  const providers = (wanted === "both" ? ["gemini", "openai"] : [wanted]) as Provider[];
  const runnable = providers.filter((p) => {
    const ok = p === "gemini" ? config.geminiApiKey : config.openaiApiKey;
    if (!ok) console.warn(`Skipping ${p}: no API key in env`);
    return ok;
  });
  if (runnable.length === 0) throw new Error("No provider has an API key. Fill GEMINI_API_KEY and/or OPENAI_API_KEY in .env");

  const summary: string[] = [];
  let anyFailed = false;
  for (const provider of runnable) {
    const model = provider === "gemini" ? config.geminiModel : config.openaiModel;
    console.log(`\n===== ${provider} (${model}) =====`);
    let passed = 0, inTok = 0, outTok = 0, ms = 0;

    for (const q of questions) {
      const system = buildSystemPrompt({
        name: "Bright Smile Dental Clinic", businessInfo: null, businessHours: null,
        bookingLink: q.bookingLink ?? null, kbText: kb,
      });
      const started = Date.now();
      try {
        const out = await generateReply({
          provider, config, system, history: [],
          userTurn: wrapCustomerMessages([q.question]),
        });
        const took = Date.now() - started;
        const problems = checkReply(out.result, q.expect);
        passed += problems.length === 0 ? 1 : 0;
        inTok += out.usage.inputTokens; outTok += out.usage.outputTokens; ms += took;
        console.log(`${problems.length ? "FAIL" : "PASS"} ${q.id} [intent=${out.result.intent} answered=${out.result.answered}] ${out.usage.inputTokens}in/${out.usage.outputTokens}out ${took}ms`);
        console.log(`     Q: ${q.question}`);
        console.log(`     A: ${out.result.reply.replace(/\n/g, " / ")}`);
        for (const p of problems) console.log(`     ! ${p}`);
        if (problems.length) anyFailed = true;
      } catch (e) {
        anyFailed = true;
        console.log(`FAIL ${q.id} ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }
    summary.push(`${provider.padEnd(7)} ${passed}/${questions.length} passed | ${inTok} in / ${outTok} out tokens | avg ${Math.round(ms / Math.max(1, questions.length))}ms`);
  }

  console.log("\n===== Summary =====");
  summary.forEach((l) => console.log(l));
  console.log("(Checks are heuristic: skim the replies above, wording differs between models.)");
  if (anyFailed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
