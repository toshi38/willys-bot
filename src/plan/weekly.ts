import type { Context } from "../core/context.ts";
import { memberByLogin } from "../core/household.ts";
import { snapshotCampaigns } from "../core/prices.ts";
import type { Dish, Recipe, Week, WeekItem } from "../core/store.ts";
import { timeline } from "../recipes/check.ts";
import { sendToMembers } from "../notify/email.ts";
import { updateSlack, type SlackButton, type SlackRef } from "../notify/slack.ts";
import { dropUnpicked, isPicked, picking, pickProblem } from "./picks.ts";
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
    // Standing orders go in by rule, as requests, before the planner plans
    // around them.
    for (const s of household.config.rules?.staples ?? []) {
      if (store.productName(s.productCode)) store.addItem(weekId, { productCode: s.productCode, qty: s.qty, reason: `Every week: ${s.name}`, source: "request", requestedBy: "standing order" }, "planner");
    }
    writeDraft(ctx, weekId, await makeDraft(ctx, weekId, { ...input, fixed: store.items(weekId) }));
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
    // Dishes a member added or picked stay; the planner's others are
    // replaced.
    const dishes = store.dishes(week.id);
    const kept = dishes.filter(isPicked);
    const old = dishes.filter((d) => !isPicked(d));
    const fixed = store.items(week.id).filter((i) => i.source === "request" || (i.dishId !== null && kept.some((d) => d.id === i.dishId)));
    const draft = await makeDraft(ctx, week.id, { fixed, keptDishes: kept.map((d) => d.name), keptWildcard: kept.some((d) => d.origin), instructions, replacing: old.map((d) => d.name) });
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

// Where an approved week's order stands on willys.se. Until the order is
// placed, the cart holds the week with its pickup slot. After that the cart
// no longer has the slot, and the order itself can only be changed on
// willys.se ("Ändra order"), which reprices it at that day's prices.
export interface OrderState {
  placed: boolean;
  // When the order must be placed for the booked slot, as willys.se says it.
  closeTime: string | null;
}

export async function orderState(ctx: Context, week: Week): Promise<OrderState> {
  await ctx.ensureLogin();
  const slot = await ctx.willys.slotInCart();
  const forWeek = !!slot && localDate(new Date(slot.startTime)) === week.id;
  return { placed: !forWeek, closeTime: forWeek ? (slot.closeTimeFormatted ?? null) : null };
}

// Sets the cart to the approved week's items, for each product the week
// has ever had, so additions, quantity changes and removals all reach it.
// Products the week never had are left alone.
export async function syncCart(ctx: Context, week: Week): Promise<string> {
  const wanted = new Map<string, number>();
  for (const i of ctx.store.allItems(week.id)) wanted.set(i.productCode, wanted.get(i.productCode) ?? 0);
  for (const i of ctx.store.items(week.id)) wanted.set(i.productCode, (wanted.get(i.productCode) ?? 0) + i.qty);
  const after = await ctx.willys.setCartQuantities([...wanted].map(([code, qty]) => ({ code, qty })));
  ctx.store.markAnnounced(week.id, week.version);
  return `${after.products.length} products, total ${after.totalPrice ?? "?"}`;
}

// After a member's message: shows a waiting week's changes, or brings an
// approved week's cart in line with them while the order is not placed.
// Returns a line to add to the reply, if any.
export async function afterChange(ctx: Context, weekId: string, state: OrderState | null, opts: { emailIntro?: string; inReplyTo?: string } = {}): Promise<{ note: string; emailed: boolean }> {
  const week = ctx.store.week(weekId);
  if (!week || week.version <= week.announcedVersion) return { note: "", emailed: false };
  if (week.status === "open") return { note: "", emailed: await announceChanges(ctx, weekId, opts).then((shown) => shown && opts.emailIntro !== undefined) };
  if (week.status !== "applied" || !state || state.placed) return { note: "", emailed: false };
  return { note: `Willys cart: ${await syncCart(ctx, week)}.`, emailed: false };
}

async function announce(ctx: Context, week: Week, emailIntro: string | undefined, inReplyTo?: string): Promise<void> {
  const { store, household } = ctx;
  let shown = false;
  if (emailIntro !== undefined) {
    const ids = JSON.parse(store.get(idsKey(week.id)) ?? "[]") as string[];
    const markdown = [emailIntro, renderWeek(ctx, week), EMAIL_FOOTER(ctx, week)].filter(Boolean).join("\n\n");
    const sent = await sendToMembers(household, { subject: `Re: ${subject(week)}`, inReplyTo: inReplyTo ?? ids.at(-1), markdown });
    store.set(idsKey(week.id), JSON.stringify([...ids, sent]));
    shown = true;
  }
  const post = slackPost(ctx, week.id);
  if (post) {
    try {
      shown = (await updateSlack(household, post, slackPlanText(ctx, week), planButtons(ctx, week))) || shown;
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
  const messageId = await sendToMembers(household, { subject: subject(week), markdown: `${body}\n\n${EMAIL_FOOTER(ctx, week)}` });
  store.set(idsKey(week.id), JSON.stringify([messageId]));
  store.updateWeek(week.id, { sentAt: new Date().toISOString(), announcedVersion: week.version });
  await toSlack(async () => {
    const ref = await postToWeek(ctx, slackPlanText(ctx, week), { buttons: planButtons(ctx, week), broadcast: true });
    const thread = await weekThread(ctx);
    if (ref && thread) {
      store.set(slackKey(week.id), JSON.stringify(ref));
      store.set(slackThreadKey(ref.ts), week.id);
      store.set(slackThreadKey(thread.ts), week.id);
    }
  });
}

const EMAIL_FOOTER = (ctx: Context, week: Week) =>
  picking(ctx, week)
    ? `---\nReply with the numbers of the dishes you want to cook (for example **1, 3, 5**), then **yes** to order them with the basics; **1, 3, 5 yes** does both. Reply **new suggestions** to replace the dishes nobody picked, **no** to skip this week, or write what to change. You can also email me any time to add to the list or update the pantry or your preferences.\n(week ${week.token})`
    : `---\nReply **yes** to fill the cart and book a pickup slot, **no** to skip this week, or write what to change: I change just that and leave the rest. You can also email me any time to add to the list or update the pantry or your preferences.\n(week ${week.token})`;

function subject(week: Week): string {
  return `Willys order: pickup ${pickupLabel(week.id)} [wb:${week.token}]`;
}

// The plan's Slack post: the week, then how to act on it, or once decided,
// the outcome instead.
function slackPlanText(ctx: Context, week: Week, outcome?: string): string {
  const how = picking(ctx, week)
    ? "Pick the dishes you want to cook with the buttons, or reply with their numbers (for example 1, 3, 5). **Order picked** fills the cart with them and the basics; **New suggestions** replaces the dishes nobody picked. Reply in this thread with anything else to change."
    : "Approve to fill the cart and book a pickup slot, or reply in this thread with what to change.";
  return `**Willys order: pickup ${pickupLabel(week.id)}**\n\n${renderWeek(ctx, week)}\n\n${outcome ? `*${outcome}*` : how}`;
}

function planButtons(ctx: Context, week: Week): SlackButton[] {
  if (!picking(ctx, week)) {
    return [
      { action: "plan.approve", label: "Approve", value: week.id, style: "primary" },
      { action: "plan.skip", label: "Skip this week", value: week.id },
    ];
  }
  const dishes = ctx.store.dishes(week.id);
  const picked = dishes.filter(isPicked).length;
  return [
    ...dishes.map((d, i) => ({ action: "plan.pick", label: `${isPicked(d) ? "✓ " : "Pick "}${i + 1}. ${short(d.name, 30)}`, value: `${week.id}:${d.id}` })),
    { action: "plan.approve", label: `Order picked (${picked})`, value: week.id, style: "primary" as const },
    { action: "plan.redraft", label: "New suggestions", value: week.id },
    { action: "plan.skip", label: "Skip this week", value: week.id },
  ];
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function slackPost(ctx: Context, weekId: string): SlackRef | null {
  const raw = ctx.store.get(slackKey(weekId));
  return raw ? (JSON.parse(raw) as SlackRef) : null;
}

// Replaces the plan's Slack post with its outcome, so the buttons go away
// whichever way (email, Slack or the web UI) the decision came.
async function markSlackPlan(ctx: Context, week: Week, outcome: string): Promise<void> {
  const post = slackPost(ctx, week.id);
  if (post) await toSlack(() => updateSlack(ctx.household, post, slackPlanText(ctx, ctx.store.week(week.id) ?? week, outcome)));
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
  const problem = pickProblem(ctx, week);
  if (problem) throw new Error(problem);
  if (opts.dryRun) return [await apply(ctx, week, opts)];
  if (!store.switchWeek(week.id, "open", "approved")) throw new Error(`Week ${week.id} changed before it could be approved`);
  store.updateWeek(week.id, { decidedBy: by, decidedAt });
  // Only the picked dishes are bought.
  dropUnpicked(ctx, week, "food-bot");
  await markSlackPlan(ctx, week, `Approved by ${who}`);
  return [`${week.id}: approved by ${by}`, await apply(ctx, store.week(week.id)!, opts)];
}

// Fills the cart with the week's items on top of whatever is already in
// it, books a pickup slot inside the household's window, marks the list
// items as ordered and the restocked pantry entries as had.
//
// Once the cart is filled the week counts as applied, even if no slot could
// be booked: the household is told to pick one on willys.se. If filling the
// cart fails, the week is marked failed, its list items go back on the
// list, and the household is told to check the cart; nothing retries on
// its own, since filling it again would double every line.
export async function apply(ctx: Context, week: Week, opts: { dryRun?: boolean } = {}): Promise<string> {
  const { store, willys, household } = ctx;
  const items = store.items(week.id);
  const wanted = new Map<string, number>();
  for (const i of items) wanted.set(i.productCode, (wanted.get(i.productCode) ?? 0) + i.qty);
  if (opts.dryRun) return `${week.id}: would add ${wanted.size} cart lines and book a slot (dry run)`;
  const ids = JSON.parse(store.get(idsKey(week.id)) ?? "[]") as string[];

  let after;
  try {
    await ctx.ensureLogin();
    const cart = await willys.cart();
    const inCart = new Map(cart.products.map((p) => [p.code, p.quantity]));
    after = await willys.setCartQuantities([...wanted].map(([code, qty]) => ({ code, qty: (inCart.get(code) ?? 0) + qty })));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateWeek(week.id, { status: "failed", error: message });
    store.releaseListItems(week.id);
    await tellHousehold(ctx, {
      subject: `Re: ${subject(week)}`,
      inReplyTo: ids.at(-1),
      markdown: `Filling the cart failed, so the order is not ready: ${message.slice(0, 300)}\n\nThe cart on willys.se may be partly filled. Check it and finish the order there; I will not try again on my own. The list items are back on the list for next week.`,
    }, undefined, { broadcast: true }).catch((e: unknown) => console.error(`Could not tell the household: ${e instanceof Error ? e.message : e}`));
    throw err;
  }

  store.orderListItems(week.id);
  for (const name of new Set(items.map((i) => i.restocks).filter((n): n is string => !!n))) store.setPantryItem({ name, status: "have", updatedBy: "food-bot" });
  store.updateWeek(week.id, { status: "applied", appliedAt: new Date().toISOString(), error: null });
  const booked = await bookSlot(ctx, store.week(week.id)!, `The cart is filled: ${after.products.length} products, total ${after.totalPrice ?? "?"}.`);
  return `${week.id}: cart filled (${after.totalPrice ?? "?"}), ${booked}`;
}

// Books the pickup slot for a week whose cart is filled and confirms it in
// Slack's channel and by email, with the recipes following in the thread.
// Also used on its own when booking failed the first time.
export async function bookSlot(ctx: Context, week: Week, cartNote: string): Promise<string> {
  const { store, willys, household } = ctx;
  let slot = null;
  let slotError: string | null = null;
  try {
    slot = await bookPickupSlot(willys, household, week.id);
  } catch (err) {
    slotError = err instanceof Error ? err.message : String(err);
  }
  store.updateWeek(week.id, { error: slotError });
  const window = `${household.config.pickup.earliest} and ${household.config.pickup.latest}`;
  const pickup = slot
    ? `Pickup booked: **${slot.formattedTime}**. Place the order at https://www.willys.se/kassa before ${slot.closeTimeFormatted ?? "the order cutoff"}, or the slot is lost.`
    : slotError
      ? `Booking the pickup slot failed (${slotError.slice(0, 200)}). Pick one when you place the order at https://www.willys.se/kassa.`
      : `No free pickup slot starting between ${window} on ${week.id}. Pick one when you place the order at https://www.willys.se/kassa.`;
  const ids = JSON.parse(store.get(idsKey(week.id)) ?? "[]") as string[];
  const recipes = renderRecipes(ctx, week);
  const sent = await tellHousehold(
    ctx,
    { subject: `Re: ${subject(week)}`, inReplyTo: ids.at(-1), markdown: [cartNote, pickup, recipes].filter(Boolean).join("\n\n") },
    `**${slot ? "Pickup booked" : "Order ready, no pickup slot booked"}**\n${cartNote}\n${pickup}`,
    { broadcast: true },
  );
  store.set(idsKey(week.id), JSON.stringify([...ids, sent]));
  if (recipes) await toSlack(() => postToWeek(ctx, recipes));
  return slot ? `slot ${slot.formattedTime}` : `slot not booked${slotError ? `: ${slotError}` : ""}`;
}

// The week as the household sees it: dishes, then what to buy grouped by
// why it is bought, so requests and each dish's ingredients are easy to
// find. While the household picks dishes, the dishes are numbered with
// what each costs, and the shopping shows the basics and the picked
// dishes: what would be ordered now.
// How long a recipe takes to cook and how much of it is hands-on, as in
// "50 min, 30 hands-on", from its timed steps; null for a recipe saved as
// text only.
export function cookingTime(recipe: Recipe | null): string | null {
  if (!recipe?.structured) return null;
  const t = timeline(recipe.structured);
  const span = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);
  return `${span(t.totalMinutes)}, ${t.activeMinutes} hands-on`;
}

export function renderWeek(ctx: Context, week: Week): string {
  const { store } = ctx;
  const choosing = picking(ctx, week);
  const dishes = store.dishes(week.id);
  const items = store.items(week.id);
  const sum = (list: WeekItem[]) => list.reduce((total, i) => total + i.qty * (i.unitPrice ?? 0), 0);
  const forDish = (d: Dish) => items.filter((i) => i.source !== "request" && i.dishId === d.id);
  const shown = dishes.filter((d) => !choosing || isPicked(d));
  const line = (i: WeekItem) => `- ${i.qty} x ${i.name ?? i.productCode}${i.unitPrice !== null ? `, ${fmt(i.unitPrice)} kr` : ""}.${i.reason ? ` ${i.reason}` : ""}`;
  const origin = (d: Dish) => (d.origin ? ` 🌍 *Wildcard from ${d.origin}.*` : "");
  const time = (d: Dish) => {
    const t = cookingTime(d.recipeId ? store.recipe(d.recipeId) : null);
    return t ? `, ${t}` : "";
  };
  const dishLines = choosing
    ? dishes.map((d, i) => `${i + 1}. ${isPicked(d) ? "✅ " : ""}**${d.name}** (${d.portions} portions, about ${Math.round(sum(forDish(d)))} kr${time(d)}).${origin(d)} ${d.why}`)
    : dishes.map((d) => `- **${d.name}** (${d.portions} portions${time(d)}).${origin(d)} ${d.why}`);
  const requests = items.filter((i) => i.source === "request");
  const rest = items.filter((i) => i.source !== "request" && (i.dishId === null || !dishes.some((d) => d.id === i.dishId)));
  const bought = [...requests, ...rest, ...shown.flatMap(forDish)];
  const heading = choosing
    ? `## Shopping for the basics${shown.length ? ` and the ${shown.length} picked dish${shown.length === 1 ? "" : "es"}` : ", until you pick dishes"} (about ${Math.round(sum(bought))} kr)`
    : `## Shopping (about ${Math.round(sum(bought))} kr)`;
  const out = [week.summary, "", choosing ? "## Suggestions" : "## Dishes", ...dishLines, "", heading];
  if (requests.length) {
    out.push("", "**Asked for**");
    for (const i of requests) out.push(`${line(i)}${i.requestedBy ? ` (${i.requestedBy})` : ""}`);
  }
  for (const d of shown) {
    const list = forDish(d);
    if (list.length) out.push("", `**For ${d.name}**`, ...list.map(line));
  }
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
