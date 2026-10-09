import type { Context } from "../core/context.ts";
import { snapshotCampaigns } from "../core/prices.ts";
import type { PlanLine, PlanRow } from "../core/store.ts";
import { classifyReply, fetchReplies, sendToMembers } from "../notify/email.ts";
import { makePlan, planLines, type Plan } from "./planner.ts";
import { bookPickupSlot } from "./slots.ts";

// The weekly cycle: propose a plan and email it, then poll for a member's
// reply. "yes" fills the Willys cart and books a pickup slot; anything other
// than yes or no is fed back to the planner and a revised plan is sent in
// the same thread. Placing the order stays a manual step on willys.se.

const idsKey = (planId: string) => `plan.${planId}.messageIds`;

export async function propose(ctx: Context, opts: { feedback?: string; replyTo?: string; dryRun?: boolean } = {}): Promise<PlanRow> {
  const { store, household, willys } = ctx;
  await snapshotCampaigns(willys, store, household.config.willys.storeId);
  const plan = await makePlan(ctx, opts.feedback ?? null);
  const { lines, unknown } = planLines(ctx, plan);
  const row = store.createPlan(plan, lines);
  const markdown = renderPlan(plan, lines, unknown, row.token);
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
  return store.plan(row.id)!;
}

// Checks every sent plan for replies and acts on the first decisive one.
export async function poll(ctx: Context, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const { store, household } = ctx;
  const log: string[] = [];
  for (const plan of store.plans(["sent"])) {
    const sentIds = JSON.parse(store.get(idsKey(plan.id)) ?? "[]") as string[];
    const replies = await fetchReplies(household, sentIds, new Date(plan.sentAt ?? plan.createdAt));
    const reply = replies[0];
    if (!reply) continue;
    const decision = classifyReply(reply.text);
    const decidedAt = new Date().toISOString();
    if (decision.kind === "approve") {
      store.updatePlan(plan.id, { status: "approved", decidedBy: reply.from, decidedAt });
      log.push(`${plan.id}: approved by ${reply.from}`);
      log.push(await apply(ctx, store.plan(plan.id)!, { dryRun: opts.dryRun, replyTo: reply.messageId }));
    } else if (decision.kind === "reject") {
      store.updatePlan(plan.id, { status: "rejected", decidedBy: reply.from, decidedAt, decisionNote: reply.text });
      log.push(`${plan.id}: rejected by ${reply.from}`);
    } else {
      store.updatePlan(plan.id, { status: "rejected", decidedBy: reply.from, decidedAt, decisionNote: reply.text });
      const next = await propose(ctx, { feedback: decision.feedback, replyTo: reply.messageId, dryRun: opts.dryRun });
      log.push(`${plan.id}: changes requested by ${reply.from}, sent revised plan ${next.id}`);
    }
  }
  return log;
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
    const sent = await sendToMembers(household, {
      subject: `Re: Willys order: week ${isoWeek(new Date(plan.createdAt))} [wb:${plan.token}]`,
      inReplyTo: opts.replyTo ?? ids[0],
      markdown: [
        `The cart is filled: ${after.products.length} products, total ${after.totalPrice ?? "?"}.`,
        slot ? `Pickup slot booked: ${slot}.` : "No pickup slot inside the window was free: pick one on willys.se.",
        "",
        "Review and place the order at https://www.willys.se/kassa",
      ].join("\n"),
    });
    store.set(idsKey(plan.id), JSON.stringify([...ids, sent]));
    return `${plan.id}: cart filled (${after.totalPrice ?? "?"}), slot ${slot ?? "not booked"}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updatePlan(plan.id, { status: "failed", error: message });
    throw err;
  }
}

export function renderPlan(plan: Plan, lines: PlanLine[], unknown: string[], token: string): string {
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
  out.push(
    "",
    "---",
    "Reply **yes** to fill the cart and book a pickup slot, **no** to skip this week, or write what to change and a new plan will follow.",
    `(plan ${token})`,
  );
  return out.join("\n");
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

const fmt = (n: number) => n.toFixed(2).replace(/\.00$/, "");
