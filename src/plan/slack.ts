import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { classifyReply } from "../notify/email.ts";
import { updateSlack } from "../notify/slack.ts";
import { runIntake } from "./inbox.ts";
import { describePicks, parsePicks, picking, pickProblem, setPicks } from "./picks.ts";
import { ratingButtons, ratingText } from "./survey.ts";
import { editable, localDate, postChanges, toSlack } from "./week.ts";
import { afterChange, announceChanges, answerOrderChange, decide, orderState, pendingOrderChange, planWeek, redraftWeek, weekForSlackThread } from "./weekly.ts";

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
    const { id, value } = req.action;
    // Ratings from the survey posts: the post shows who rated what.
    if (id === "dish.rate" || id === "dish.notcooked") {
      const [dishId, stars] = value.split(":").map(Number);
      const dish = store.dish(dishId!);
      if (!dish) return { reply: "I cannot find that dish any more." };
      if (id === "dish.rate") store.rateDish(dish.id, member.name, stars!);
      const cooked = id === "dish.rate" || store.dishRatings(dish.id).length > 0;
      await updateSlack(household, { channel: req.where.channel, ts: req.where.ts }, ratingText(ctx, dish, !cooked), cooked ? ratingButtons(dish) : []);
      return {};
    }
    const weekId = value.split(":")[0]!;
    const week = store.week(weekId);
    if (!week) return { reply: "That plan has been replaced: use the buttons on the latest plan." };
    if (week.status !== "open") return { reply: `This week is already ${week.status}${week.decidedBy ? ` (${memberByLogin(household, week.decidedBy)?.name ?? week.decidedBy})` : ""}.` };
    if (id === "plan.pick") {
      const dish = store.dish(Number(value.split(":")[1]));
      if (!dish || dish.weekId !== week.id || dish.removedAt) return { reply: "That dish is no longer in the plan." };
      store.pickDish(dish.id, dish.pickedBy === null, member.email);
      await announceChanges(ctx, week.id);
      return {};
    }
    if (id === "plan.redraft") {
      const result = await redraftWeek(ctx, week, "New suggestions for the dishes nobody picked.", member.email);
      return result.done ? {} : { reply: `I could not get new suggestions: ${result.message}.` };
    }
    const kind = id === "plan.approve" ? "approve" : id === "plan.skip" ? "skip" : null;
    if (!kind) return { reply: `I do not know the button ${id}.` };
    const problem = kind === "approve" ? pickProblem(ctx, week) : null;
    if (problem) return { reply: problem };
    // decide() replaces the plan's post with the outcome, and on approval
    // posts the cart and pickup slot in its thread.
    await decided(() => decide(ctx, week, kind, member.email));
    return {};
  }

  const inThread = weekForSlackThread(ctx, req.where.threadTs);
  if (inThread?.status === "open") {
    // "1, 3, 5" picks those dishes; "1, 3, 5 yes" also orders them.
    const picks = picking(ctx, inThread) ? parsePicks(req.text, store.dishes(inThread.id).length) : null;
    if (picks) {
      setPicks(ctx, inThread, picks.numbers, member.email);
      const reply = describePicks(ctx, inThread, member.email);
      if (!picks.order) {
        await announceChanges(ctx, inThread.id);
        return { reply: `${reply} Tap Order picked or reply yes to order them.` };
      }
      await decided(() => decide(ctx, store.week(inThread.id)!, "approve", member.email));
      return { reply };
    }
    const decision = classifyReply(req.text);
    if (decision.kind === "approve") {
      const problem = pickProblem(ctx, inThread);
      if (problem) return { reply: problem };
    }
    if (decision.kind !== "change") {
      await decided(() => decide(ctx, inThread, decision.kind === "approve" ? "approve" : "skip", member.email));
      return {};
    }
  }
  // A message in a closed week's thread is about the current shop, if any.
  const week = inThread && editable(inThread) ? inThread : (store.currentWeek(localDate(new Date())) ?? inThread);
  // A plain yes or no answers a waiting question about changing the placed
  // order at today's prices.
  if (week?.status === "applied" && editable(week) && pendingOrderChange(ctx, week.id)) {
    const answer = classifyReply(req.text).kind;
    if (answer !== "change") return { reply: await answerOrderChange(ctx, week, answer === "approve") };
  }
  const order = week?.status === "applied" && editable(week) ? await orderState(ctx, week) : null;
  const outcome = await runIntake(ctx, { name: member.name, via: "slack", subject: "", text: req.text, week, order, thread: req.thread });
  let reply = outcome.reply;
  if (outcome.redraft) {
    const result = week?.status === "open" ? await redraftWeek(ctx, week, outcome.redraft, member.email) : await planWeek(ctx, { instructions: outcome.redraft });
    if (!result.done) reply = `${reply}\n\n(I could not start new dishes: ${result.message}.)`.trim();
  } else if (week) {
    const { note } = await afterChange(ctx, week.id, order);
    if (note) reply = `${reply}\n\n${note}`.trim();
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
