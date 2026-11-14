import { summaryOrFallback, SOURCE_LABELS, type HandoffSource } from "./handoff";
import {
  ACTION_FAILED_REPLY, decideAction, nextWorkflowState, OPEN_REQUEST_REPLY, REJECTED_SUBMIT_REPLY,
  type AppointmentInput, type Decision, type LeadInput, type WorkflowState,
} from "./workflow";
import { bookingMode, type WorkflowSettings } from "./workflow-settings";
import { z } from "zod";
import { errorText } from "./inbound";
import type { OwnerEvent } from "./email/templates";
import type { PromptClient } from "./ai/prompt";
import type { ChatTurn, Provider } from "./ai/providers";
import type { GenerateReplyOutput, Usage } from "./ai/generate-reply";
import { InvalidModelOutputError } from "./ai/generate-reply";
import type { ReplyResult } from "./ai/schema";
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
  workflow: WorkflowSettings;
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
    workflowState: WorkflowState | null;
  };
  /** The customer's open appointment request, if any (so the assistant never collects a second one). */
  openAppointment: { status: "pending" | "reschedule_requested"; rescheduleNote: string | null } | null;
  contact: { id: string; name: string | null };
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
  createHandoff(clientId: string, conversationId: string, input: { source: HandoffSource; reason: string; summary: string }): Promise<{ created: boolean }>;
  updateConversation(clientId: string, conversationId: string, patch: { handling?: "human_active"; failedAnswerCount?: number; workflowState?: WorkflowState | null }): Promise<void>;
  /** Idempotent: an open request for this conversation already existing returns created=false. */
  saveAppointment(clientId: string, ctx: BatchContext, a: AppointmentInput): Promise<{ created: boolean }>;
  /** Idempotent: the same enquiry for this conversation returns created=false. */
  saveLead(clientId: string, ctx: BatchContext, l: LeadInput): Promise<{ created: boolean }>;
  recordFailedUsage(clientId: string, usage: Usage, provider: Provider, model: string): Promise<void>;
  raiseAlert(clientId: string | null, kind: string, detail: string, opts?: { oncePerMonth?: boolean }): Promise<void>;
  /** Fills empty contact fields; differing values go to contacts.suggested for the owner to confirm. */
  applyContactDetails(clientId: string, contactId: string, details: { name: string | null; email: string | null }): Promise<void>;
  /** True only for the call that flipped the contact from 'new' to 'lead'. */
  markLead(clientId: string, contactId: string): Promise<boolean>;
  notifyOwner(clientId: string, event: OwnerEvent): Promise<void>;
  /** Records a question the assistant could not answer, so the owner can add it to the knowledge base. */
  logUnanswered(clientId: string, conversationId: string, question: string): Promise<void>;
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

  // The model only PROPOSES an action. Decide here, BEFORE the customer is told anything, and save first:
  // "your request has been submitted" is only sent when it really was.
  const mode = bookingMode(client.bookingLink, client.workflow);
  const dctx = { prev: conversation.workflowState, result: gen.result, mode, settings: client.workflow, contactName: ctx.contact.name, now };
  let decision: Decision = decideAction(dctx);
  let replyText = gen.result.reply;
  let created = false;
  let failedSource: HandoffSource | null = null;
  let handoffSummary: string | undefined;
  if (decision.kind === "rejected") {
    console.warn("workflow action rejected", { clientId: client.id, flow: decision.flow, reason: decision.reason });
    replyText = REJECTED_SUBMIT_REPLY;
  } else if (decision.kind === "appointment" && ctx.openAppointment) {
    // One open request per chat. A second one is NOT silently dropped: a person gets it, with the details.
    const v = decision.value;
    const when = [v.preferredDate, v.preferredTime].filter(Boolean).join(" ");
    handoffSummary = `Asked for another appointment while one is still open: ${v.purpose}${when ? `, ${when}` : ""}${v.notes ? `. Notes: ${v.notes}` : ""}.`.slice(0, 400);
    replyText = OPEN_REQUEST_REPLY;
    failedSource = "action_failed";
    decision = { kind: "none" };
  } else if (decision.kind === "appointment" || decision.kind === "lead") {
    try {
      const saved = decision.kind === "appointment"
        ? await deps.saveAppointment(client.id, ctx, decision.value)
        : await deps.saveLead(client.id, ctx, decision.value);
      created = saved.created;
    } catch (e) {
      console.error("saving workflow request failed", errorText(e));
      try { await deps.raiseAlert(client.id, "workflow_save_failed", `${decision.kind}: ${errorText(e)}`); } catch { /* never throws here */ }
      replyText = ACTION_FAILED_REPLY;
      failedSource = "action_failed";
      decision = { kind: "none" };
    }
  }
  await sendGuarded(ctx, deps, now, replyText, { usage: gen.usage, provider: gen.provider, model: gen.model });

  // The customer has their reply. Everything below is bookkeeping: a failure
  // here is alerted but must NOT trigger the "something went wrong" fallback.
  await afterReply(ctx, deps, gen.result, lines, { decision, created, failedSource, handoffSummary, mode, now });
}

type AfterInfo = { decision: Decision; created: boolean; failedSource: HandoffSource | null; handoffSummary?: string; mode: ReturnType<typeof bookingMode>; now: Date };

async function afterReply(ctx: BatchContext, deps: BatchDeps, result: ReplyResult, lines: string[], info: AfterInfo): Promise<void> {
  const { client, conversation, contact } = ctx;
  const { decision, created, failedSource, handoffSummary, mode, now } = info;
  const lastMessage = lines.join(" / ");

  // CRM: model-extracted details are guesses; validate, then store as suggestions.
  const details = cleanContactDetails(result.contact);
  const name = details.name ?? (decision.kind === "appointment" ? decision.value.customerName : null);
  if (name || details.email) {
    await safely(deps, client.id, "crm", () => deps.applyContactDetails(client.id, contact.id, { name, email: details.email }));
  }

  // Questions we could not answer go to a list the owner can turn into knowledge.
  // (Handoff requests and workflow steps are not knowledge gaps.)
  const bookingNeedsPerson = result.intent === "appointment_request" && mode === "handoff";
  if (!result.answered && result.intent !== "human_needed" && !bookingNeedsPerson && !result.workflow.flow) {
    await safely(deps, client.id, "unanswered", () => deps.logUnanswered(client.id, conversation.id, lastMessage.slice(0, 500)));
  }

  // First time we hear from this contact: they become a lead (owner emailed once).
  await safely(deps, client.id, "lead", async () => {
    if (await deps.markLead(client.id, contact.id)) {
      await deps.notifyOwner(client.id, { type: "new_lead", contactName: contact.name, phone: ctx.phone, firstMessage: lastMessage });
    }
  });

  // A saved request: the owner is told once (created=false means it already existed, e.g. a retried webhook).
  if (created && decision.kind === "appointment") {
    const v = decision.value;
    await safely(deps, client.id, "appointment_email", () => deps.notifyOwner(client.id, {
      type: "appointment_request", contactName: v.customerName, phone: ctx.phone, purpose: v.purpose,
      preferredDate: v.preferredDate, preferredTime: v.preferredTime, appointmentType: v.appointmentType, notes: v.notes,
    }));
  }
  if (created && decision.kind === "lead") {
    const v = decision.value;
    await safely(deps, client.id, "lead_email", () => deps.notifyOwner(client.id, {
      type: "lead_created", contactName: v.customerName ?? contact.name, phone: ctx.phone, projectType: v.projectType,
      budget: v.budget, timeline: v.timeline, summary: v.summary, status: v.status,
    }));
  }

  // Handoff rules: customer asked for a person / is upset (model intent), a booking that needs a person,
  // two failed answers in a row, or a request that could not be saved. Switched off per business in Settings.
  const handoffOn = client.workflow.handoff.enabled;
  const askedForHuman = result.intent === "human_needed";
  const failed = result.answered || bookingNeedsPerson || result.workflow.flow || !handoffOn ? 0 : conversation.failedAnswerCount + 1;
  const handoff = failedSource !== null || (handoffOn && (askedForHuman || bookingNeedsPerson || failed >= HANDOFF_AFTER_FAILED_ANSWERS));
  const source: HandoffSource = failedSource ?? (askedForHuman ? "customer_request" : bookingNeedsPerson ? "booking_without_link" : "failed_answers");

  // 1) The silence switch (it is what stops the assistant) and the workflow state, then 2) the record and the email.
  const nextState = failedSource ? null : nextWorkflowState({ prev: conversation.workflowState, result, decision, mode, settings: client.workflow, contactName: contact.name, now });
  const stateChanged = JSON.stringify(nextState) !== JSON.stringify(conversation.workflowState);
  await safely(deps, client.id, "conversation", () => deps.updateConversation(client.id, conversation.id, {
    failedAnswerCount: failed,
    ...(handoff ? { handling: "human_active" as const } : {}),
    ...(stateChanged ? { workflowState: nextState } : {}),
  }));
  if (handoff) {
    await safely(deps, client.id, "handoff", async () => {
      const summary = handoffSummary ?? summaryOrFallback(result.summary, lastMessage);
      // Idempotent: a retried webhook finds the open request and gets created=false, so no second email.
      const { created: opened } = await deps.createHandoff(client.id, conversation.id, { source, reason: SOURCE_LABELS[source], summary });
      if (opened) {
        await deps.notifyOwner(client.id, { type: "needs_human", contactName: contact.name, phone: ctx.phone, lastMessage, reason: source, summary });
      }
    });
  }
}

const emailSchema = z.string().email().max(200);

/** Trim, drop junk like "n/a", and require a real email address before anything is stored. */
export function cleanContactDetails(c: ReplyResult["contact"]): { name: string | null; email: string | null } {
  const name = c.name?.trim();
  const email = emailSchema.safeParse(c.email?.trim());
  return {
    name: name && name.length >= 2 && !/^(n\/a|none|unknown|null)$/i.test(name) ? name : null,
    email: email.success ? email.data : null,
  };
}

// Runs a bookkeeping step; on failure logs and alerts instead of throwing.
async function safely(deps: BatchDeps, clientId: string, step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`post-reply step failed: ${step}`, errorText(e));
    try {
      await deps.raiseAlert(clientId, "post_reply_step_failed", `${step}: ${errorText(e)}`);
    } catch {
      /* alerting must never throw here */
    }
  }
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
