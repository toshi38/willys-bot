import { z } from "zod";
import { runClaude } from "../core/claude.ts";
import type { Context } from "../core/context.ts";
import { loadHousehold, memberByLogin } from "../core/household.ts";
import type { Week } from "../core/store.ts";
import {
  address,
  addressedTo,
  automated,
  classifyReply,
  getReceived,
  listReceived,
  planToken,
  replyText,
  senderAuthenticated,
  type ReceivedEmail,
} from "../notify/email.ts";
import { editable, localDate, postChanges, tellHousehold, toSlack } from "./week.ts";
import { afterChange, announceChanges, decide, expireWeeks, orderState, planWeek, redraftWeek, renderWeek, type OrderState } from "./weekly.ts";

// Email to the bot's address, read from Resend on a timer. Only mail from a
// household member whose domain the receiving server verified is acted on;
// everything else is recorded as ignored and gets no answer.
//
// A plain yes or no on a week waiting for a decision approves or skips it.
// Anything else goes to Claude with the week, list, pantry and preferences
// tools: it makes just the changes the email asks for and replies with
// what it did, and the updated plan when the week changed.

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
  if (!opts.dryRun) {
    await expireWeeks(ctx);
    // Catch the Slack post up on changes it missed (the gateway was down).
    const open = store.openWeek();
    if (open) await toSlack(() => announceChanges(ctx, open.id));
  }
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
        await tellHousehold(ctx, {
          subject: reSubject(email.subject),
          inReplyTo: email.message_id,
          markdown: `Sorry ${member!.name}, I could not handle this email after ${attempts} tries, so nothing was changed. Stephen can see why in the bot's log.\n\n(${message.slice(0, 300)})`,
        });
      }
    }
  }
  if (!opts.dryRun) await toSlack(() => postChanges(ctx));
  return log;
}

// Once a decision has been acted on or Claude has made its changes, the
// email counts as handled even if telling the household fails afterwards:
// trying it again would repeat the changes.
async function handleEmail(ctx: Context, email: ReceivedEmail, name: string, from: string): Promise<string[]> {
  const { store } = ctx;
  const text = replyText(email);
  const token = planToken(email.subject ?? "");
  const answered = token ? store.weekByToken(token) : null;
  const log: string[] = [];
  const settle = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      log.push(`${email.id}: ${what} failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (answered?.status === "open") {
    const decision = classifyReply(text);
    if (decision.kind !== "change") {
      // A failed approval tells the household itself (see apply).
      await settle(decision.kind === "approve" ? "approving" : "skipping", async () => log.push(...(await decide(ctx, answered, decision.kind === "approve" ? "approve" : "skip", from))));
      return log;
    }
  }

  // A reply about a closed week is about the current shop, if any.
  const week = answered && editable(answered) ? answered : (store.currentWeek(localDate(new Date())) ?? answered);
  const order = week?.status === "applied" && editable(week) ? await orderState(ctx, week) : null;
  const outcome = await runIntake(ctx, { name, via: "email", subject: email.subject ?? "", text, week, order, thread: [] });
  log.push(`${email.id} from ${name}: ${outcome.summary}`);
  let reply = outcome.reply;
  if (outcome.redraft) {
    await settle("redrafting", async () => {
      const result = week?.status === "open" ? await redraftWeek(ctx, week, outcome.redraft, from) : await planWeek(ctx, { instructions: outcome.redraft });
      log.push(result.message);
      if (!result.done) reply = `${reply}\n\n(I could not start new dishes: ${result.message}.)`.trim();
    });
  }
  let shown = false;
  if (week && !outcome.redraft) {
    await settle("updating", async () => {
      const done = await afterChange(ctx, week.id, order, { emailIntro: reply, inReplyTo: email.message_id });
      shown = done.emailed;
      if (done.note) reply = `${reply}\n\n${done.note}`.trim();
    });
  }
  if (!shown && reply) {
    await settle("replying", () =>
      tellHousehold(ctx, { subject: reSubject(email.subject), markdown: reply, inReplyTo: email.message_id }, `**${name} emailed:** ${quote(text)}\n\n${reply}`),
    );
  }
  return log;
}

export const IntakeOutput = z.object({
  reply: z.string().default(""),
  redraft: z.string().default(""),
  summary: z.string().default("handled"),
});

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Your answer to the household saying what you changed, or answering the question." },
    redraft: { type: "string", description: "Only when the person wants a whole new set of dishes, or a plan when none exists: instructions for the planner. Otherwise empty." },
    summary: { type: "string", description: "One line for the operator's log." },
  },
  required: ["reply", "redraft", "summary"],
};

const SYSTEM_PROMPT = `You are food-bot, the assistant for a household's weekly grocery shop at Willys, a Swedish supermarket. A household member has written to you, by email or in Slack. Do what they ask with your tools, then write a short, friendly reply.

What you can change:
- The shopping list (list_add, list_update, list_remove): things to buy in the next order. Use search_products when they name a specific product.
- The pantry (pantry_set, pantry_remove): what they keep at home. "We are out of X" or "running low on Y" belongs here unless they need it this week.
- The preferences (preferences_view, then preferences_update): dietary rules, likes and dislikes, staples, budget and habits. Keep everything that still holds and change only what they told you. Celiac and allergy rules can be tightened from a message but never loosened without the person saying so plainly.
- This week's shop (week_view, week_add_item, week_set_quantity, week_remove_item, dish_add, dish_remove, recipe_view): once a week is drafted, change it here, one item or dish at a time. Change exactly what they asked and nothing else: everything you do not touch stays as it is. Things to buy this week go straight into the week with week_add_item; the shopping list is for later weeks, or when no week is open.
- To swap a dish: dish_remove it, dish_add the new one with its recipe (or a known recipeId), then week_add_item its ingredients with the new dish's id. Search for real products and follow the preferences, above all the dietary rules.
- Items with source "request" were asked for by a member. Never remove or change one unless a member asks for that.
- A whole new set of dishes, or a plan when no week exists: only then, put instructions for the planner in redraft. Requests are kept.
- Approving or skipping the week is done by replying yes or no to the plan email, or with the Approve and Skip buttons in Slack; if they seem to want that, tell them so.

Rules:
- Only act on what the message asks. If something is ambiguous, do the safe part and ask about the rest in your reply.
- Your reply goes to every household member. Say concretely what you changed. Keep it short.
- Write in the language the person wrote in. Never use em dashes or en dashes; use commas, colons or full stops.`;

export interface IntakeInput {
  name: string;
  via: "email" | "slack" | "web";
  // The email subject; empty for Slack.
  subject: string;
  text: string;
  // The week the message is about: the one it answers, or the current week.
  week: Week | null;
  // For an approved week, where its order stands on willys.se.
  order?: OrderState | null;
  // Earlier messages in the Slack thread, oldest first.
  thread: { from: string; text: string }[];
}

// Hands a member's message to Claude with the week, list, pantry and
// preferences tools. The household's preferences are reloaded afterwards,
// since the tools edit them in another process and a redraft must see
// the change.
export async function runIntake(ctx: Context, input: IntakeInput): Promise<z.infer<typeof IntakeOutput>> {
  const lines = [`From: ${input.name}, by ${{ email: "email", slack: "Slack", web: "the web UI" }[input.via]}`];
  if (input.subject) lines.push(`Subject: ${input.subject}`);
  lines.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
  const week = input.week;
  if (week) {
    const state =
      week.status === "open"
        ? "waiting for a decision, open for changes"
        : !editable(week)
          ? `${week.status}, no longer open for changes`
          : input.order && !input.order.placed
            ? `approved: the Willys cart is filled but the order is not placed yet${input.order.closeTime ? ` (it must be placed before ${input.order.closeTime})` : ""}. Changes you make to the week are copied to the cart automatically`
            : "approved and the order is already placed on willys.se. Changes you make are recorded in the week but do not reach the order: tell them to change the order on willys.se (Ändra order) at least 24 hours before pickup, and that a changed order is charged at that day's prices, so sale prices can make it cost more or less";
    lines.push("", `## This week's shop (pickup ${week.id}: ${state})`, renderWeek(ctx, week));
  } else {
    lines.push("", "## This week's shop", "No week is planned for the next pickup yet.");
  }
  if (input.thread.length) lines.push("", "## Earlier in the thread", ...input.thread.map((m) => `${m.from}: ${m.text}`));
  lines.push("", "## Message", input.text || "(empty)", "", `Write your reply in ${messageLanguage(input.text)}, the language of the message above, even though the thread, the preferences or the product names may be in another language.`);
  const output = await runClaude(ctx, {
    systemPrompt: SYSTEM_PROMPT,
    prompt: lines.join("\n"),
    schema: INTAKE_SCHEMA,
    week: input.week?.id,
    tools: [
      "week_view", "week_add_item", "week_set_quantity", "week_remove_item", "dish_add", "dish_remove", "recipe_view",
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

// The language a member wrote in, from its common words: product names are
// often Swedish in an English message, so Swedish letters only decide a
// tie. Decided here rather than left to Claude, which drifts towards the
// thread's or the preferences' language.
export function messageLanguage(text: string): "Swedish" | "English" {
  const words = text.toLowerCase().split(/[^a-zåäöé]+/);
  const count = (list: string[]) => words.filter((w) => list.includes(w)).length;
  const sv = count(["och", "jag", "vi", "inte", "det", "att", "är", "kan", "ska", "har", "vill", "till", "med", "för", "på", "tack", "hej", "nej", "ja", "som", "en", "ett", "den", "av", "om", "också", "bara", "lite", "mer", "behöver"]);
  const en = count(["the", "and", "to", "for", "with", "from", "is", "a", "an", "of", "we", "i", "it", "this", "that", "wants", "want", "can", "please", "also", "remove", "add", "swap", "instead", "have", "need", "some", "more", "in", "on", "was", "are"]);
  if (sv !== en) return sv > en ? "Swedish" : "English";
  return /[åäö]/i.test(text) ? "Swedish" : "English";
}

// The start of an email, quoted for the weekly thread.
function quote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}...` : t;
}

function reSubject(subject: string | null): string {
  const s = subject?.trim() || "food-bot";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
