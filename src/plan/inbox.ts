import { z } from "zod";
import { runClaude } from "../core/claude.ts";
import type { Context } from "../core/context.ts";
import { loadHousehold, memberByLogin } from "../core/household.ts";
import type { PlanRow } from "../core/store.ts";
import {
  address,
  addressedTo,
  automated,
  classifyReply,
  getReceived,
  listReceived,
  planToken,
  replyText,
  sendToMembers,
  senderAuthenticated,
  type ReceivedEmail,
} from "../notify/email.ts";
import { decide, propose } from "./weekly.ts";

// Email to the bot's address, read from Resend on a timer. Only mail from a
// household member whose domain the receiving server verified is acted on;
// everything else is recorded as ignored and gets no answer.
//
// A plain yes or no on a plan waiting for a decision approves or rejects
// it. Anything else goes to Claude with the list, pantry and preferences
// tools: it makes the changes the email asks for, says what it did in a
// reply to the household, and passes on any change to this week's plan to
// the planner.

const MAX_ATTEMPTS = 3;
const LOOKBACK_DAYS = 7;
const SINCE_KEY = "mail.since";

export async function handleInbox(ctx: Context, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const { store, household } = ctx;
  const bot = household.config.mail.address;
  // Mail from before the first run is left alone; after that, a week back
  // covers any downtime.
  let start = store.get(SINCE_KEY);
  if (!start) {
    start = new Date().toISOString();
    if (!opts.dryRun) store.set(SINCE_KEY, start);
  }
  const since = new Date(Math.max(new Date(start).getTime(), Date.now() - LOOKBACK_DAYS * 86_400_000));
  const log: string[] = [];
  const received = (await listReceived(household, since)).filter((e) => addressedTo(e, bot)).reverse();
  for (const summary of received) {
    const seen = store.mailRecord(summary.id);
    if (seen && seen.status !== "retry") continue;
    const email = await getReceived(household, summary.id);
    const from = address(email.from);
    const base = { id: email.id, receivedAt: email.created_at, sender: from, subject: email.subject ?? "" };
    const member = memberByLogin(household, from);
    const refusal = !member
      ? "not a household member"
      : !senderAuthenticated(email)
        ? `sender not verified (${JSON.stringify(email.authentication)})`
        : automated(email)
          ? "automated reply"
          : null;
    if (refusal) {
      log.push(`${email.id} from ${from}: ignored, ${refusal}`);
      if (!opts.dryRun) store.recordMail({ ...base, status: "ignored", attempts: 0, note: refusal });
      continue;
    }
    if (opts.dryRun) {
      log.push(`${email.id} from ${member!.name}: would handle "${email.subject}": ${replyText(email).slice(0, 80)}`);
      continue;
    }
    const attempts = (seen?.attempts ?? 0) + 1;
    try {
      const done = await handleEmail(ctx, email, member!.name, from);
      store.recordMail({ ...base, status: "handled", attempts, note: done.join("; ") });
      log.push(...done);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = attempts >= MAX_ATTEMPTS;
      store.recordMail({ ...base, status: final ? "failed" : "retry", attempts, note: message });
      log.push(`${email.id} from ${member!.name}: attempt ${attempts} failed: ${message}`);
      if (final) {
        await sendToMembers(household, {
          subject: reSubject(email.subject),
          inReplyTo: email.message_id,
          markdown: `Sorry ${member!.name}, I could not handle this email after ${attempts} tries, so nothing was changed. Stephen can see why in the bot's log.\n\n(${message.slice(0, 300)})`,
        });
      }
    }
  }
  return log;
}

async function handleEmail(ctx: Context, email: ReceivedEmail, name: string, from: string): Promise<string[]> {
  const { store, household } = ctx;
  const text = replyText(email);
  const token = planToken(email.subject ?? "");
  const plan = token ? store.planByToken(token) : null;
  const waiting = plan?.status === "sent" ? plan : null;
  if (waiting) {
    const decision = classifyReply(text);
    if (decision.kind !== "change") return decide(ctx, waiting, decision, from, { replyTo: email.message_id });
  }

  const outcome = await runIntake(ctx, { name, via: "email", subject: email.subject ?? "", text, plan, thread: [] });
  const log = [`${email.id} from ${name}: ${outcome.summary}`];
  if (outcome.reply) {
    await sendToMembers(household, { subject: reSubject(email.subject), markdown: outcome.reply, inReplyTo: email.message_id });
  }
  if (outcome.planFeedback) {
    if (waiting) log.push(...(await decide(ctx, waiting, { kind: "change", feedback: outcome.planFeedback }, from, { replyTo: email.message_id })));
    else log.push(`new plan ${(await propose(ctx, { feedback: outcome.planFeedback, replyTo: email.message_id })).id}`);
  }
  return log;
}

export const IntakeOutput = z.object({
  reply: z.string().default(""),
  planFeedback: z.string().default(""),
  summary: z.string().default("handled"),
});

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Your answer to the household saying what you changed, or answering the question. Empty if a revised plan is all the answer needed." },
    planFeedback: { type: "string", description: "Instructions for the planner when the person wants this week's plan changed or asks for a new plan; otherwise empty." },
    summary: { type: "string", description: "One line for the operator's log." },
  },
  required: ["reply", "planFeedback", "summary"],
};

const SYSTEM_PROMPT = `You are food-bot, the assistant for a household's weekly grocery shop at Willys, a Swedish supermarket. A household member has written to you, by email or in Slack. Do what they ask with your tools, then write a short, friendly reply.

What you can change:
- The shopping list (list_add, list_update, list_remove): things to buy in the next order. Use search_products when they name a specific product.
- The pantry (pantry_set, pantry_remove): what they keep at home. "We are out of X" or "running low on Y" belongs here unless they need it this week.
- The preferences (preferences_view, then preferences_update): dietary rules, likes and dislikes, staples, budget and habits. Keep everything that still holds and change only what they told you. Celiac and allergy rules can be tightened from a message but never loosened without the person saying so plainly.
- This week's plan: you cannot edit it. If they want it changed, or ask for a new plan, put precise instructions for the planner in planFeedback and a revised plan will be sent. Approving or skipping a plan is done by replying yes or no to the plan email, or with the Approve and Skip buttons on the plan in Slack; if they seem to want that, tell them so.

Rules:
- Only act on what the message asks. If something is ambiguous, do the safe part and ask about the rest in your reply.
- Your reply goes to every household member. Say concretely what you changed. Keep it short.
- Write in the language the person wrote in. Never use em dashes or en dashes; use commas, colons or full stops.`;

export interface IntakeInput {
  name: string;
  via: "email" | "slack";
  // The email subject; empty for Slack.
  subject: string;
  text: string;
  // The plan the message answers, when it answers one.
  plan: PlanRow | null;
  // Earlier messages in the Slack thread, oldest first.
  thread: { from: string; text: string }[];
}

// Hands a member's message to Claude with the list, pantry and
// preferences tools. The household's preferences are reloaded afterwards,
// since the tools edit them in another process and a revised plan must see
// the change.
export async function runIntake(ctx: Context, input: IntakeInput): Promise<z.infer<typeof IntakeOutput>> {
  const lines = [`From: ${input.name}, by ${input.via === "email" ? "email" : "Slack"}`];
  if (input.subject) lines.push(`Subject: ${input.subject}`);
  lines.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
  const plan = input.plan;
  if (plan) {
    lines.push(
      "",
      `This message answers plan ${plan.id}, which is ${plan.status}${plan.status === "sent" ? " (waiting for a decision)" : ""}. Its shopping lines:`,
      ...plan.lines.map((l) => `- ${l.qty} x ${l.name}`),
    );
  }
  if (input.thread.length) lines.push("", "## Earlier in the thread", ...input.thread.map((m) => `${m.from}: ${m.text}`));
  lines.push("", "## Message", input.text || "(empty)");
  const output = await runClaude(ctx, {
    systemPrompt: SYSTEM_PROMPT,
    prompt: lines.join("\n"),
    schema: INTAKE_SCHEMA,
    tools: [
      "list_view", "list_add", "list_update", "list_remove",
      "pantry_view", "pantry_set", "pantry_remove",
      "preferences_view", "preferences_update",
      "search_products", "current_offers",
    ],
    member: input.name,
    readOnly: false,
  });
  ctx.household.preferences = loadHousehold(ctx.household.id).preferences;
  return IntakeOutput.parse(output);
}

function reSubject(subject: string | null): string {
  const s = subject?.trim() || "food-bot";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
