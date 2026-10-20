import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { classifyReply } from "../notify/email.ts";
import { runIntake } from "./inbox.ts";
import { postChanges, toSlack } from "./week.ts";
import { decide, planForSlackThread, propose } from "./weekly.ts";

// food-bot's side of slack-gateway's contract: one request in, one response
// out. The gateway has already checked the workspace; who may use food-bot
// is decided here, from the Slack user's verified email, the same way as
// for email. Replies in this week's thread are about the latest plan in it.

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
  const response = await respond(ctx, req);
  // Whatever the message changed goes in this week's thread straight away.
  await toSlack(() => postChanges(ctx));
  return response;
}

async function respond(ctx: Context, req: SlackRequest): Promise<SlackResponse> {
  const { store, household } = ctx;
  const member = memberByLogin(household, req.from.email);
  if (!member) return { reply: "Sorry, I only take requests from the household." };

  if (req.type === "action") {
    const kind = req.action.id === "plan.approve" ? "approve" : req.action.id === "plan.skip" ? "reject" : null;
    if (!kind) return { reply: `I do not know the button ${req.action.id}.` };
    const plan = store.plan(req.action.value);
    if (!plan) return { reply: "I cannot find that plan any more." };
    if (plan.status !== "sent") return { reply: `This plan is already ${plan.status}${plan.decidedBy ? ` (${memberByLogin(household, plan.decidedBy)?.name ?? plan.decidedBy})` : ""}.` };
    // decide() replaces the plan's post with the outcome, and on approval
    // posts the cart and pickup slot in its thread.
    await decide(ctx, plan, { kind }, member.email);
    return {};
  }

  const plan = planForSlackThread(ctx, req.where.threadTs);
  const waiting = plan?.status === "sent" ? plan : null;
  if (waiting) {
    const decision = classifyReply(req.text);
    if (decision.kind !== "change") {
      await decide(ctx, waiting, decision, member.email);
      return {};
    }
  }
  const outcome = await runIntake(ctx, { name: member.name, via: "slack", subject: "", text: req.text, plan, thread: req.thread });
  if (outcome.planFeedback) {
    if (waiting) await decide(ctx, waiting, { kind: "change", feedback: outcome.planFeedback }, member.email);
    else await propose(ctx, { feedback: outcome.planFeedback });
  }
  return { reply: outcome.reply };
}
