import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { classifyReply } from "../notify/email.ts";
import { runIntake } from "./inbox.ts";
import { postChanges, toSlack } from "./week.ts";
import { announceChanges, decide, planWeek, redraftWeek, weekForSlackThread } from "./weekly.ts";

// food-bot's side of slack-gateway's contract: one request in, one response
// out. The gateway has already checked the workspace; who may use food-bot
// is decided here, from the Slack user's verified email, the same way as
// for email. Replies in this week's thread are about that week.

export type SlackRequest =
  | { type: "message"; from: { email: string; name: string }; text: string; where: Where; thread: { from: string; text: string }[] }
  | { type: "action"; from: { email: string; name: string }; action: { id: string; value: string }; where: Where };

interface Where {
  channel: string;
  ts: string;
  threadTs: string | null;
}

export interface SlackResponse {
  reply?: string;
}

export async function handleSlack(ctx: Context, req: SlackRequest): Promise<SlackResponse> {
  const record = (reply: string | null, error: string | null) =>
    ctx.store.recordSlack({
      channel: req.where.channel,
      ts: req.where.ts,
      threadTs: req.where.threadTs,
      sender: req.from.email,
      name: req.from.name,
      kind: req.type,
      text: req.type === "message" ? req.text : `${req.action.id} ${req.action.value}`,
      reply,
      error,
    });
  let response: SlackResponse;
  try {
    response = await respond(ctx, req);
  } catch (err) {
    // The error goes back to whoever asked, in the conversation they asked
    // in, rather than only into the log.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Slack request failed: ${message}`);
    response = { reply: `Sorry, that went wrong: ${message.slice(0, 300)}\nSome of it may already be done; ask me what the week looks like now.` };
    record(response.reply ?? null, message);
    await toSlack(() => postChanges(ctx));
    return response;
  }
  record(response.reply ?? null, null);
  // Whatever the message changed goes in this week's thread straight away.
  await toSlack(() => postChanges(ctx));
  return response;
}

async function respond(ctx: Context, req: SlackRequest): Promise<SlackResponse> {
  const { store, household } = ctx;
  const member = memberByLogin(household, req.from.email);
  if (!member) return { reply: "Sorry, I only take requests from the household." };

  if (req.type === "action") {
    const kind = req.action.id === "plan.approve" ? "approve" : req.action.id === "plan.skip" ? "skip" : null;
    if (!kind) return { reply: `I do not know the button ${req.action.id}.` };
    const week = store.week(req.action.value);
    if (!week) return { reply: "That plan has been replaced: use the buttons on the latest plan." };
    if (week.status !== "open") return { reply: `This week is already ${week.status}${week.decidedBy ? ` (${memberByLogin(household, week.decidedBy)?.name ?? week.decidedBy})` : ""}.` };
    // decide() replaces the plan's post with the outcome, and on approval
    // posts the cart and pickup slot in its thread.
    await decided(() => decide(ctx, week, kind, member.email));
    return {};
  }

  const inThread = weekForSlackThread(ctx, req.where.threadTs);
  if (inThread?.status === "open") {
    const decision = classifyReply(req.text);
    if (decision.kind !== "change") {
      await decided(() => decide(ctx, inThread, decision.kind === "approve" ? "approve" : "skip", member.email));
      return {};
    }
  }
  // A message in a closed week's thread is about the shop now open, if any.
  const week = inThread?.status === "open" ? inThread : (store.openWeek() ?? inThread);
  const outcome = await runIntake(ctx, { name: member.name, via: "slack", subject: "", text: req.text, week, thread: req.thread });
  let reply = outcome.reply;
  if (outcome.redraft) {
    const result = week?.status === "open" ? await redraftWeek(ctx, week, outcome.redraft, member.email) : await planWeek(ctx, { instructions: outcome.redraft });
    if (!result.done) reply = `${reply}\n\n(I could not start new dishes: ${result.message}.)`.trim();
  } else if (week) {
    await announceChanges(ctx, week.id);
  }
  return { reply };
}

// A failed approval has already told the household in the channel (see
// apply), so it is only logged here.
async function decided(f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (err) {
    console.error(`Decision failed: ${err instanceof Error ? err.message : err}`);
  }
}
