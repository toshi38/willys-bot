import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { snapshotCampaigns } from "../core/prices.ts";
import type { Week, WeekItem } from "../core/store.ts";
import { sendToMembers } from "../notify/email.ts";
import { updateSlack, type SlackButton, type SlackRef } from "../notify/slack.ts";
import { makeDraft, writeDraft } from "./planner.ts";
import { bookPickupSlot } from "./slots.ts";
import { localDate, nextPickup, postToWeek, tellHousehold, toSlack, weekThread } from "./week.ts";

// The weekly cycle. The planner drafts the shop for the next pickup once.
// After that the shop is its rows: members change it by email, Slack or the
// web UI, Claude edits single dishes and items, and the household is shown
// the updated plan. Asking for new dishes redrafts the dishes and keeps
// everything members asked for. Approval fills the Willys cart and books a
// pickup slot; placing the order stays a manual step on willys.se.

const idsKey = (weekId: string) => `week.${weekId}.messageIds`;
const slackKey = (weekId: string) => `week.${weekId}.slack`;
const slackThreadKey = (ts: string) => `slack.thread.${ts}`;

// The week a Slack thread belongs to: the week's thread and the plan's own
// post both lead to it.
export function weekForSlackThread(ctx: Context, threadTs: string | null): Week | null {
  const id = threadTs ? ctx.store.get(slackThreadKey(threadTs)) : null;
  return id ? ctx.store.week(id) : null;
}

export interface Outcome {
  done: boolean;
  message: string;
}

// The scheduled run: drafts and sends the shop for the next pickup, unless
// that week already exists. Weeks whose pickup passed without a decision
// are closed first. A dry run drafts and prints without saving.
export async function planWeek(ctx: Context, opts: { dryRun?: boolean; instructions?: string } = {}): Promise<Outcome> {
  const { store, household, willys } = ctx;
  if (!opts.dryRun) await expireWeeks(ctx);
  const weekId = localDate(nextPickup(household));
  let existing = store.week(weekId);
  if (existing?.status === "drafting" && store.draftAbandoned(weekId)) {
    // The process drafting it died. A first draft left nothing behind (it
    // is written in one transaction); a redraft left the week as it was.
    if (store.dishes(weekId).length) store.switchWeek(weekId, "drafting", "open");
    else store.dropWeek(weekId);
    existing = store.week(weekId);
  }
  if (existing?.status === "open" && !existing.sentAt && !opts.dryRun) {
    await sendWeek(ctx, existing);
    return { done: true, message: `Week ${weekId} was drafted but not sent: sent it now` };
  }
  if (existing) return { done: false, message: `Week ${weekId} is already ${existing.status}: not drafting it again` };
  await snapshotCampaigns(willys, store, household.config.willys.storeId);
  const input = { fixed: [], keptDishes: [], instructions: opts.instructions ?? null, replacing: [] };
  if (opts.dryRun) {
    const d = await makeDraft(ctx, weekId, input);
    console.log(JSON.stringify(d, null, 2));
    return { done: true, message: `Week ${weekId} drafted (dry run, nothing saved)` };
  }
  if (!store.claimWeek(weekId)) return { done: false, message: `Week ${weekId} is being drafted by another run` };
  try {
    writeDraft(ctx, weekId, await makeDraft(ctx, weekId, input));
  } catch (err) {
    store.dropWeek(weekId);
    throw err;
  }
  store.switchWeek(weekId, "drafting", "open");
  await sendWeek(ctx, store.week(weekId)!);
  return { done: true, message: `Week ${weekId} drafted and sent` };
}

// Closes open weeks whose pickup day has passed: nobody decided, so the
// week is skipped and its list items go back on the list.
export async function expireWeeks(ctx: Context): Promise<void> {
  for (const w of ctx.store.staleWeeks(localDate(new Date()))) {
    if (!ctx.store.switchWeek(w.id, "open", "skipped")) continue;
    ctx.store.updateWeek(w.id, { decidedBy: "food-bot", decidedAt: new Date().toISOString() });
    ctx.store.releaseListItems(w.id);
    await markSlackPlan(ctx, w, "Not decided before pickup, so not ordered");
  }
}

// Replaces the planner's dishes with new ones, keeping every request and
// every dish a member added. Only one redraft runs at a time, and the week
// takes no edits meanwhile.
export async function redraftWeek(ctx: Context, week: Week, instructions: string, by: string): Promise<Outcome> {
  const { store } = ctx;
  const who = memberByLogin(ctx.household, by)?.name ?? by;
  if (!store.switchWeek(week.id, "open", "drafting")) return { done: false, message: `the week for pickup ${week.id} is ${store.week(week.id)?.status ?? "gone"}, so it cannot get new dishes now` };
  try {
    const dishes = store.dishes(week.id);
    const old = dishes.filter((d) => d.addedBy === "planner");
    const kept = dishes.filter((d) => d.addedBy !== "planner");
    const fixed = store.items(week.id).filter((i) => i.source === "request" || (i.dishId !== null && kept.some((d) => d.id === i.dishId)));
    const draft = await makeDraft(ctx, week.id, { fixed, keptDishes: kept.map((d) => d.name), instructions, replacing: old.map((d) => d.name) });
    store.transaction(() => {
      for (const d of old) store.removeDish(d.id, who);
      for (const i of store.items(week.id)) if (i.source === "staple") store.removeItem(i.id, who);
      writeDraft(ctx, week.id, draft);
    });
  } finally {
    store.switchWeek(week.id, "drafting", "open");
  }
  store.changed(week.id, who, `asked for new dishes: ${store.dishes(week.id).map((d) => d.name).join(", ")}`);
  await announce(ctx, store.week(week.id)!, `${who} asked for new dishes. Here is the updated plan.`);
  return { done: true, message: `Week ${week.id} redrafted for ${who}` };
}

// Shows the household the plan after changes, if it changed since they
// last saw it. The plan's Slack post is rewritten in place (the changes
// themselves are posted in the week's thread). With emailIntro, which
// changes made by email pass, the updated plan is also emailed, starting
// with that text.
export async function announceChanges(ctx: Context, weekId: string, opts: { emailIntro?: string; inReplyTo?: string } = {}): Promise<boolean> {
  const week = ctx.store.week(weekId);
  if (!week || week.status !== "open" || week.version <= week.announcedVersion) return false;
  await announce(ctx, week, opts.emailIntro, opts.inReplyTo);
  return true;
}

async function announce(ctx: Context, week: Week, emailIntro: string | undefined, inReplyTo?: string): Promise<void> {
  const { store, household } = ctx;
  let shown = false;
  if (emailIntro !== undefined) {
    const ids = JSON.parse(store.get(idsKey(week.id)) ?? "[]") as string[];
    const markdown = [emailIntro, renderWeek(ctx, week), EMAIL_FOOTER(week)].filter(Boolean).join("\n\n");
    const sent = await sendToMembers(household, { subject: `Re: ${subject(week)}`, inReplyTo: inReplyTo ?? ids.at(-1), markdown });
    store.set(idsKey(week.id), JSON.stringify([...ids, sent]));
    shown = true;
  }
  const post = slackPost(ctx, week.id);
  if (post) {
    try {
      shown = (await updateSlack(household, post, slackPlanText(ctx, week), planButtons(week))) || shown;
    } catch (err) {
      // Not marked as shown, so the next change or run tries again.
      console.error(`Slack: ${err instanceof Error ? err.message : err}`);
    }
  } else if (!household.config.slack) {
    shown = true;
  }
  if (shown) store.markAnnounced(week.id, week.version);
}

async function sendWeek(ctx: Context, week: Week): Promise<void> {
  const { store, household } = ctx;
  const body = renderWeek(ctx, week);
  const messageId = await sendToMembers(household, { subject: subject(week), markdown: `${body}\n\n${EMAIL_FOOTER(week)}` });
  store.set(idsKey(week.id), JSON.stringify([messageId]));
  store.updateWeek(week.id, { sentAt: new Date().toISOString(), announcedVersion: week.version });
  await toSlack(async () => {
    const ref = await postToWeek(ctx, slackPlanText(ctx, week), { buttons: planButtons(week), broadcast: true });
    const thread = await weekThread(ctx);
    if (ref && thread) {
      store.set(slackKey(week.id), JSON.stringify(ref));
      store.set(slackThreadKey(ref.ts), week.id);
      store.set(slackThreadKey(thread.ts), week.id);
    }
  });
}

const EMAIL_FOOTER = (week: Week) =>
  `---\nReply **yes** to fill the cart and book a pickup slot, **no** to skip this week, or write what to change: I change just that and leave the rest. You can also email me any time to add to the list or update the pantry or your preferences.\n(week ${week.token})`;

function subject(week: Week): string {
  return `Willys order: pickup ${pickupLabel(week.id)} [wb:${week.token}]`;
}

function slackPlanText(ctx: Context, week: Week): string {
  return `**Willys order: pickup ${pickupLabel(week.id)}**\n\n${renderWeek(ctx, week)}\n\nApprove to fill the cart and book a pickup slot, or reply in this thread with what to change.`;
}

function planButtons(week: Week): SlackButton[] {
  return [
    { action: "plan.approve", label: "Approve", value: week.id, style: "primary" },
    { action: "plan.skip", label: "Skip this week", value: week.id },
  ];
}

function slackPost(ctx: Context, weekId: string): SlackRef | null {
  const raw = ctx.store.get(slackKey(weekId));
  return raw ? (JSON.parse(raw) as SlackRef) : null;
}

// Replaces the plan's Slack post with its outcome, so the buttons go away
// whichever way (email, Slack or the web UI) the decision came.
async function markSlackPlan(ctx: Context, week: Week, outcome: string): Promise<void> {
  const post = slackPost(ctx, week.id);
  if (post) await toSlack(() => updateSlack(ctx.household, post, `${slackPlanText(ctx, week).split("\n\nApprove to fill")[0]}\n\n*${outcome}*`));
}

// Acts on a member approving or skipping the week.
export async function decide(ctx: Context, week: Week, kind: "approve" | "skip", by: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const { store } = ctx;
  if (week.status !== "open") throw new Error(`Week ${week.id} is ${week.status}, not waiting for a decision`);
  const decidedAt = new Date().toISOString();
  const who = memberByLogin(ctx.household, by)?.name ?? by;
  if (kind === "skip") {
    if (!store.switchWeek(week.id, "open", "skipped")) throw new Error(`Week ${week.id} changed before it could be skipped`);
    store.updateWeek(week.id, { decidedBy: by, decidedAt });
    store.releaseListItems(week.id);
    await markSlackPlan(ctx, week, `Skipped this week by ${who}`);
    return [`${week.id}: skipped by ${by}`];
  }
  if (opts.dryRun) return [await apply(ctx, week, opts)];
  if (!store.switchWeek(week.id, "open", "approved")) throw new Error(`Week ${week.id} changed before it could be approved`);
  store.updateWeek(week.id, { decidedBy: by, decidedAt });
  await markSlackPlan(ctx, week, `Approved by ${who}`);
  return [`${week.id}: approved by ${by}`, await apply(ctx, store.week(week.id)!, opts)];
}

// Fills the cart with the week's items on top of whatever is already in
// it, books a pickup slot inside the household's window, marks the list
// items as ordered and the restocked pantry entries as had. On failure the
// week is marked failed, its list items go back on the list, and the
// household is told what to check: the cart may be partly filled, so
// nothing retries on its own.
export async function apply(ctx: Context, week: Week, opts: { dryRun?: boolean } = {}): Promise<string> {
  const { store, willys, household } = ctx;
  const items = store.items(week.id);
  const wanted = new Map<string, number>();
  for (const i of items) wanted.set(i.productCode, (wanted.get(i.productCode) ?? 0) + i.qty);
  if (opts.dryRun) return `${week.id}: would add ${wanted.size} cart lines and book a slot (dry run)`;
  const ids = JSON.parse(store.get(idsKey(week.id)) ?? "[]") as string[];

  try {
    await ctx.ensureLogin();
    const cart = await willys.cart();
    const inCart = new Map(cart.products.map((p) => [p.code, p.quantity]));
    const after = await willys.setCartQuantities([...wanted].map(([code, qty]) => ({ code, qty: (inCart.get(code) ?? 0) + qty })));
    const slot = await bookPickupSlot(willys, household);
    store.orderListItems(week.id);
    for (const name of new Set(items.map((i) => i.restocks).filter((n): n is string => !!n))) store.setPantryItem({ name, status: "have", updatedBy: "food-bot" });
    store.updateWeek(week.id, { status: "applied", appliedAt: new Date().toISOString() });
    const note = [
      `The cart is filled: ${after.products.length} products, total ${after.totalPrice ?? "?"}.`,
      slot ? `Pickup slot booked: ${slot}.` : "No pickup slot inside the window was free: pick one on willys.se.",
      "",
      "Review and place the order at https://www.willys.se/kassa",
      "",
      renderRecipes(ctx, week),
    ].join("\n");
    const sent = await tellHousehold(ctx, { subject: `Re: ${subject(week)}`, inReplyTo: ids.at(-1), markdown: note }, `**Order ready**\n${note}`);
    store.set(idsKey(week.id), JSON.stringify([...ids, sent]));
    return `${week.id}: cart filled (${after.totalPrice ?? "?"}), slot ${slot ?? "not booked"}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateWeek(week.id, { status: "failed", error: message });
    store.releaseListItems(week.id);
    await tellHousehold(ctx, {
      subject: `Re: ${subject(week)}`,
      inReplyTo: ids.at(-1),
      markdown: `Filling the cart failed, so the order is not ready: ${message.slice(0, 300)}\n\nThe cart on willys.se may be partly filled. Check it and finish the order there; I will not try again on my own. The list items are back on the list for next week.`,
    }).catch((e: unknown) => console.error(`Could not tell the household: ${e instanceof Error ? e.message : e}`));
    throw err;
  }
}

// The week as the household sees it: dishes, then what to buy grouped by
// why it is bought, so requests and each dish's ingredients are easy to
// find.
export function renderWeek(ctx: Context, week: Week): string {
  const { store, household } = ctx;
  const dishes = store.dishes(week.id);
  const items = store.items(week.id);
  const total = items.reduce((sum, i) => sum + i.qty * (i.unitPrice ?? 0), 0);
  const line = (i: WeekItem) => `- ${i.qty} x ${i.name ?? i.productCode}${i.unitPrice !== null ? `, ${fmt(i.unitPrice)} kr` : ""}.${i.reason ? ` ${i.reason}` : ""}`;
  const out = [week.summary, "", "## Dishes", ...dishes.map((d) => `- **${d.name}** (${d.portions} portions). ${d.why}`), "", `## Shopping (about ${Math.round(total)} kr)`];
  const requests = items.filter((i) => i.source === "request");
  if (requests.length) {
    out.push("", "**Asked for**");
    for (const i of requests) out.push(`${line(i)}${i.requestedBy ? ` (${i.requestedBy})` : ""}`);
  }
  for (const d of dishes) {
    const forDish = items.filter((i) => i.source !== "request" && i.dishId === d.id);
    if (forDish.length) out.push("", `**For ${d.name}**`, ...forDish.map(line));
  }
  const rest = items.filter((i) => i.source !== "request" && (i.dishId === null || !dishes.some((d) => d.id === i.dishId)));
  if (rest.length) out.push("", "**Basics and restocks**", ...rest.map(line));
  if (week.notes) out.push("", "## Notes", week.notes);
  return out.join("\n");
}

export function renderRecipes(ctx: Context, week: Week): string {
  const out = ["## Recipes"];
  for (const d of ctx.store.dishes(week.id)) {
    const r = d.recipeId ? ctx.store.recipe(d.recipeId) : null;
    if (!r) continue;
    out.push("", `### ${d.name} (${d.portions} portions)`, ...r.ingredients.split("\n").filter(Boolean).map((l) => `- ${l}`), "", r.method);
  }
  return out.length > 1 ? out.join("\n") : "";
}

function pickupLabel(weekId: string): string {
  return new Date(`${weekId}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

const fmt = (n: number) => n.toFixed(2).replace(/\.00$/, "");
