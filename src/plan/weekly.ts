import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { snapshotCampaigns } from "../core/prices.ts";
import type { PlanLine, PlanRow } from "../core/store.ts";
import { sendToMembers, type Decision } from "../notify/email.ts";
import { updateSlack, type SlackRef } from "../notify/slack.ts";
import { makePlan, planLines, type Plan } from "./planner.ts";
import { bookPickupSlot } from "./slots.ts";
import { postToWeek, tellHousehold, toSlack, weekThread } from "./week.ts";

// The weekly cycle: propose a plan and email it, then act on a member's
// decision (an email reply, see inbox.ts, or the web UI). Approval fills the
// Willys cart and books a pickup slot; a change request is fed back to the
// planner and a revised plan is sent in the same thread. Placing the order
// stays a manual step on willys.se.

const idsKey = (planId: string) => `plan.${planId}.messageIds`;
const slackKey = (planId: string) => `plan.${planId}.slack`;
const slackThreadKey = (ts: string) => `slack.thread.${ts}`;

// The plan a Slack thread belongs to: the week's thread and the plan's own
// post both lead to the latest plan posted in that week.
export function planForSlackThread(ctx: Context, threadTs: string | null): PlanRow | null {
  const id = threadTs ? ctx.store.get(slackThreadKey(threadTs)) : null;
  return id ? ctx.store.plan(id) : null;
}

export async function propose(ctx: Context, opts: { feedback?: string; replyTo?: string; dryRun?: boolean } = {}): Promise<PlanRow> {
  const { store, household, willys } = ctx;
  await snapshotCampaigns(willys, store, household.config.willys.storeId);
  const plan = await makePlan(ctx, opts.feedback ?? null);
  const { lines, unknown } = planLines(ctx, plan);
  const row = store.createPlan(plan, lines);
  const body = renderPlan(plan, lines, unknown);
  const markdown = `${body}\n\n---\nReply **yes** to fill the cart and book a pickup slot, **no** to skip this week, or write what to change and a new plan will follow. You can also email me any time to add to the list or update the pantry or your preferences.\n(plan ${row.token})`;
  if (opts.dryRun) {
    console.log(markdown);
    return row;
  }

  for (const old of store.plans(["sent"])) {
    store.updatePlan(old.id, { status: "rejected", decisionNote: `superseded by ${row.id}` });
  }
  const messageId = await sendToMembers(household, {
    subject: `Willys order: week ${isoWeek(new Date())} [wb:${row.token}]`,
    markdown,
    inReplyTo: opts.replyTo,
  });
  store.set(idsKey(row.id), JSON.stringify([messageId]));
  store.updatePlan(row.id, { status: "sent", sentAt: new Date().toISOString() });
  await toSlack(async () => {
    const title = `**Willys order: week ${isoWeek(new Date())}**\n\n${body}`;
    const ref = await postToWeek(ctx, `${title}\n\nApprove to fill the cart and book a pickup slot, or reply in this thread with what to change.`, {
      buttons: [
        { action: "plan.approve", label: "Approve", value: row.id, style: "primary" },
        { action: "plan.skip", label: "Skip this week", value: row.id },
      ],
      broadcast: true,
    });
    const thread = await weekThread(ctx);
    if (ref && thread) {
      store.set(slackKey(row.id), JSON.stringify({ ...ref, title }));
      store.set(slackThreadKey(ref.ts), row.id);
      store.set(slackThreadKey(thread.ts), row.id);
    }
  });
  return store.plan(row.id)!;
}

function slackPost(ctx: Context, planId: string): (SlackRef & { title: string }) | null {
  const raw = ctx.store.get(slackKey(planId));
  return raw ? (JSON.parse(raw) as SlackRef & { title: string }) : null;
}

// Replaces the plan's Slack post with its outcome, so the buttons go away
// whichever way (email, Slack or the web UI) the decision came.
async function markSlackPlan(ctx: Context, planId: string, outcome: string): Promise<void> {
  const post = slackPost(ctx, planId);
  if (post) await toSlack(() => updateSlack(ctx.household, post, `${post.title}\n\n*${outcome}*`));
}

// Acts on a member's decision about a sent plan, whether it came from an
// email reply or the web UI.
export async function decide(ctx: Context, plan: PlanRow, decision: Decision, by: string, opts: { replyTo?: string; dryRun?: boolean } = {}): Promise<string[]> {
  const { store } = ctx;
  if (plan.status !== "sent") throw new Error(`Plan ${plan.id} is ${plan.status}, not waiting for a decision`);
  const decidedAt = new Date().toISOString();
  const who = memberByLogin(ctx.household, by)?.name ?? by;
  if (decision.kind === "approve") {
    store.updatePlan(plan.id, { status: "approved", decidedBy: by, decidedAt });
    await markSlackPlan(ctx, plan.id, `Approved by ${who}`);
    return [`${plan.id}: approved by ${by}`, await apply(ctx, store.plan(plan.id)!, opts)];
  }
  const note = decision.kind === "change" ? decision.feedback : "rejected";
  store.updatePlan(plan.id, { status: "rejected", decidedBy: by, decidedAt, decisionNote: note });
  await markSlackPlan(ctx, plan.id, decision.kind === "reject" ? `Skipped this week by ${who}` : `${who} asked for changes, a revised plan follows`);
  if (decision.kind === "reject") return [`${plan.id}: rejected by ${by}`];
  const replyTo = opts.replyTo ?? (JSON.parse(store.get(idsKey(plan.id)) ?? "[]") as string[]).at(-1);
  const next = await propose(ctx, { feedback: decision.feedback, replyTo, dryRun: opts.dryRun });
  return [`${plan.id}: changes requested by ${by}, sent revised plan ${next.id}`];
}

// Fills the cart with the plan's lines on top of whatever is already in it,
// books a pickup slot inside the household's window, and marks the list
// items as ordered.
export async function apply(ctx: Context, plan: PlanRow, opts: { dryRun?: boolean; replyTo?: string } = {}): Promise<string> {
  const { store, willys, household } = ctx;
  await ctx.ensureLogin();
  const cart = await willys.cart();
  const inCart = new Map(cart.products.map((p) => [p.code, p.quantity]));
  const wanted = new Map<string, number>();
  for (const l of plan.lines) wanted.set(l.productCode, (wanted.get(l.productCode) ?? 0) + l.qty);
  const updates = [...wanted].map(([code, qty]) => ({ code, qty: (inCart.get(code) ?? 0) + qty }));
  if (opts.dryRun) return `${plan.id}: would set ${updates.length} cart lines and book a slot (dry run)`;

  try {
    const after = await willys.setCartQuantities(updates);
    const slot = await bookPickupSlot(willys, household);
    for (const id of new Set(plan.lines.flatMap((l) => l.listItemIds))) store.updateListItem(id, { status: "ordered", planId: plan.id });
    for (const name of new Set(plan.lines.map((l) => l.restocks).filter((n): n is string => !!n))) {
      store.setPantryItem({ name, status: "have", updatedBy: "food-bot" });
    }
    store.updatePlan(plan.id, { status: "applied", appliedAt: new Date().toISOString() });
    const ids = JSON.parse(store.get(idsKey(plan.id)) ?? "[]") as string[];
    const note = [
      `The cart is filled: ${after.products.length} products, total ${after.totalPrice ?? "?"}.`,
      slot ? `Pickup slot booked: ${slot}.` : "No pickup slot inside the window was free: pick one on willys.se.",
      "",
      "Review and place the order at https://www.willys.se/kassa",
    ].join("\n");
    const sent = await tellHousehold(
      ctx,
      { subject: `Re: Willys order: week ${isoWeek(new Date(plan.createdAt))} [wb:${plan.token}]`, inReplyTo: opts.replyTo ?? ids[0], markdown: note },
      `**Order ready**\n${note}`,
    );
    store.set(idsKey(plan.id), JSON.stringify([...ids, sent]));
    return `${plan.id}: cart filled (${after.totalPrice ?? "?"}), slot ${slot ?? "not booked"}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updatePlan(plan.id, { status: "failed", error: message });
    throw err;
  }
}

// The plan itself, without the instructions on how to answer, which differ
// between email and Slack.
export function renderPlan(plan: Plan, lines: PlanLine[], unknown: string[]): string {
  const total = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  const out = [
    plan.summary,
    "",
    "## Dishes",
    ...plan.meals.map((m) => `- **${m.dish}** (${m.portions} portions). ${m.why}`),
    "",
    `## Shopping (about ${Math.round(total)} kr)`,
    ...lines.map((l) => `- ${l.qty} x ${l.name}, ${fmt(l.unitPrice)} kr. ${l.reason}`),
  ];
  if (plan.skipped.length) out.push("", "## Not bought", ...plan.skipped.map((s) => `- List item #${s.listItemId}: ${s.reason}`));
  if (unknown.length) out.push("", `Dropped ${unknown.length} product code(s) the planner did not look up: ${unknown.join(", ")}`);
  if (plan.notes) out.push("", "## Notes", plan.notes);
  return out.join("\n");
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

const fmt = (n: number) => n.toFixed(2).replace(/\.00$/, "");
