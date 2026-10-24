import { errorText } from "./inbound";
import type { PromptClient } from "./ai/prompt";
import type { ChatTurn, Provider } from "./ai/providers";
import type { GenerateReplyOutput, Usage } from "./ai/generate-reply";
import { InvalidModelOutputError } from "./ai/generate-reply";
import { isWithinWindow } from "./whatsapp/window";

// Batch worker: turns the pending messages of one conversation into ONE reply.
// Flow: claim -> load -> (AI or canned reply) -> send -> save -> complete.
// All I/O goes through BatchDeps so the logic is unit-testable.

export const BATCH_WAIT_MS = 4500; // 4s batch window + a little slack for clock skew
export const MAX_LOOPS = 5; // safety bound on "more messages arrived while replying"
export const CUSTOMER_MESSAGES_PER_HOUR = 30; // per-customer rate limit
export const HANDOFF_AFTER_FAILED_ANSWERS = 2;

export const NON_TEXT_REPLY = "Sorry, I can only read text messages right now. Could you please type your message?";
export const FALLBACK_REPLY = "Sorry, something went wrong on our side. Please try again in a moment.";
export const CAP_REPLY = "Thanks for your message! Our team will get back to you personally as soon as they can.";

export type BatchClient = PromptClient & {
  id: string;
  waPhoneNumberId: string;
  aiProvider: Provider;
  monthlyMessageCap: number;
};

export type PendingItem = { id: string; type: string; body: string | null };

export type BatchContext = {
  client: BatchClient;
  conversation: {
    id: string;
    handling: "bot" | "human_active";
    failedAnswerCount: number;
    lastCustomerMessageAt: Date | null;
  };
  phone: string;
  pending: PendingItem[]; // oldest first
  history: ChatTurn[]; // earlier turns, customer turns already wrapped
  repliesThisMonth: number;
  recentInboundCount: number; // customer messages in the last hour
};

export type SaveReply = {
  clientId: string;
  conversationId: string;
  waMessageId: string | null;
  body: string;
  status: "sent" | "blocked";
  error?: string;
  usage?: Usage;
  provider?: Provider;
  model?: string;
};

export interface BatchDeps {
  claim(conversationId: string): Promise<boolean>;
  load(conversationId: string): Promise<BatchContext | null>;
  /** Removes handled pending rows and releases the lease. True if more messages arrived meanwhile. */
  complete(conversationId: string, pendingIds: string[]): Promise<boolean>;
  generate(ctx: BatchContext, customerLines: string[], hasUnreadableMedia: boolean): Promise<GenerateReplyOutput>;
  sendText(ctx: BatchContext, body: string): Promise<{ waMessageId: string }>;
  saveReply(rec: SaveReply): Promise<void>;
  updateConversation(clientId: string, conversationId: string, patch: { handling?: "human_active"; failedAnswerCount?: number }): Promise<void>;
  recordFailedUsage(clientId: string, usage: Usage, provider: Provider, model: string): Promise<void>;
  raiseAlert(clientId: string | null, kind: string, detail: string, opts?: { oncePerMonth?: boolean }): Promise<void>;
  findDueBatches(limit: number): Promise<string[]>;
  sleep(ms: number): Promise<void>;
}

/** Process one conversation's pending messages. Safe to call from many places at once. */
export async function processConversationBatch(conversationId: string, deps: BatchDeps, now = () => new Date()): Promise<void> {
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    if (!(await deps.claim(conversationId))) return; // not due, or another worker owns it

    let ctx: BatchContext | null = null;
    let pendingIds: string[] = [];
    try {
      ctx = await deps.load(conversationId);
      if (ctx) {
        pendingIds = ctx.pending.map((p) => p.id);
        await handleBatch(ctx, deps, now());
      }
    } catch (e) {
      await handleFailure(e, ctx, deps, now());
    }

    // Release even after a failure: the customer already got the fallback, and
    // keeping the rows would make every sweep retry (and re-fail) forever.
    const more = await deps.complete(conversationId, pendingIds);
    if (!more) return;
    await deps.sleep(BATCH_WAIT_MS); // new messages arrived while we were replying
  }
}

/** Find overdue batches (stranded by a crashed worker) and process them. */
export async function sweepDueBatches(deps: BatchDeps, limit = 5): Promise<number> {
  const ids = await deps.findDueBatches(limit);
  for (const id of ids) {
    try {
      await processConversationBatch(id, deps);
    } catch (e) {
      console.error("sweep: batch failed", errorText(e));
    }
  }
  return ids.length;
}

/** What the webhook runs in after(): wait out the batch window, process, then sweep. */
export async function runBatches(conversationIds: string[], deps: BatchDeps): Promise<void> {
  await Promise.all(
    conversationIds.map(async (id) => {
      try {
        await deps.sleep(BATCH_WAIT_MS);
        await processConversationBatch(id, deps);
      } catch (e) {
        console.error("batch failed", errorText(e));
      }
    }),
  );
  try {
    await sweepDueBatches(deps);
  } catch (e) {
    console.error("sweep failed", errorText(e));
  }
}

async function handleBatch(ctx: BatchContext, deps: BatchDeps, now: Date): Promise<void> {
  const { client, conversation } = ctx;
  if (conversation.handling === "human_active") return; // a person took over meanwhile
  if (ctx.pending.length === 0) return;

  // Per-customer rate limit: past it, stop spending money. Nothing is sent.
  if (ctx.recentInboundCount > CUSTOMER_MESSAGES_PER_HOUR) {
    console.warn("rate limit hit", { clientId: client.id, conversationId: conversation.id });
    return;
  }

  const lines = ctx.pending.filter((p) => p.type === "text" && p.body).map((p) => p.body as string);
  const hasMedia = ctx.pending.some((p) => p.type !== "text");

  // Only media (voice, images): ask for text, no AI call needed.
  if (lines.length === 0) {
    await sendGuarded(ctx, deps, now, NON_TEXT_REPLY);
    return;
  }

  // Monthly usage cap: checked BEFORE the model call.
  if (ctx.repliesThisMonth >= client.monthlyMessageCap) {
    await deps.raiseAlert(client.id, "monthly_cap_reached", `Cap of ${client.monthlyMessageCap} replies reached`, { oncePerMonth: true });
    await sendGuarded(ctx, deps, now, CAP_REPLY);
    return;
  }

  const gen = await deps.generate(ctx, lines, hasMedia);
  await sendGuarded(ctx, deps, now, gen.result.reply, { usage: gen.usage, provider: gen.provider, model: gen.model });

  // Handoff rules: customer asked for a person / is upset (model intent), or two failed answers in a row.
  const failed = gen.result.answered ? 0 : conversation.failedAnswerCount + 1;
  const handoff = gen.result.intent === "human_needed" || failed >= HANDOFF_AFTER_FAILED_ANSWERS;
  await deps.updateConversation(client.id, conversation.id, {
    failedAnswerCount: failed,
    ...(handoff ? { handling: "human_active" as const } : {}),
  });
}

// Every outbound free-form message goes through here: 24h window check first.
async function sendGuarded(
  ctx: BatchContext, deps: BatchDeps, now: Date, body: string,
  extra: Pick<SaveReply, "usage" | "provider" | "model"> = {},
): Promise<void> {
  const base = { clientId: ctx.client.id, conversationId: ctx.conversation.id, body, ...extra };
  if (!isWithinWindow(ctx.conversation.lastCustomerMessageAt, now)) {
    await deps.saveReply({ ...base, waMessageId: null, status: "blocked", error: "outside_24h_window" });
    return;
  }
  const sent = await deps.sendText(ctx, body);
  await deps.saveReply({ ...base, waMessageId: sent.waMessageId, status: "sent" });
}

// Any failure: alert the admin and, only when it is safe, send a fallback.
async function handleFailure(e: unknown, ctx: BatchContext | null, deps: BatchDeps, now: Date): Promise<void> {
  const detail = errorText(e);
  console.error("batch processing failed", detail);
  try {
    if (e instanceof InvalidModelOutputError && ctx) {
      await deps.recordFailedUsage(ctx.client.id, e.usage, e.provider, e.model);
    }
    await deps.raiseAlert(ctx?.client.id ?? null, "batch_processing_failed", detail);
  } catch (alertErr) {
    console.error("could not record failure", errorText(alertErr));
  }
  if (ctx && ctx.conversation.handling === "bot" && isWithinWindow(ctx.conversation.lastCustomerMessageAt, now)) {
    try {
      await sendGuarded(ctx, deps, now, FALLBACK_REPLY);
    } catch (fallbackErr) {
      console.error("fallback send failed", errorText(fallbackErr));
    }
  }
}
