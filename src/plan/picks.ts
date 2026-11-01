import type { Context } from "../core/context.ts";
import { memberByLogin, picksDishes } from "../core/household.ts";
import type { Dish, Week } from "../core/store.ts";

// Households that get more suggestions than they cook pick the dishes they
// want, with Slack buttons, by replying with the dishes' numbers, or by
// asking food-bot in their own words. Only picked dishes are ordered: on
// approval the rest are removed with their ingredients. Requests, staples
// and dishes a member added themselves are always kept.

// True while a week is waiting for the household to pick its dishes.
export function picking(ctx: Context, week: Week | null): boolean {
  return !!week && week.status === "open" && picksDishes(ctx.household);
}

// A dish counts as picked when a member picked it or added it themselves.
export function isPicked(d: Dish): boolean {
  return d.pickedBy !== null || d.addedBy !== "planner";
}

export function pickedDishes(ctx: Context, week: Week): Dish[] {
  return ctx.store.dishes(week.id).filter(isPicked);
}

// Why the week cannot be ordered yet, or null when it can.
export function pickProblem(ctx: Context, week: Week): string | null {
  if (!picking(ctx, week) || pickedDishes(ctx, week).length) return null;
  return "Pick the dishes you want to cook first: tap their Pick buttons in Slack or reply with their numbers (for example 1, 3, 5). Only picked dishes are ordered.";
}

const FILLER = new Set([
  "pick", "picks", "picked", "take", "we", "we'll", "well", "ill", "i'll", "i", "want", "have", "go", "for", "with", "dish", "dishes", "number", "numbers", "nr", "and", "please", "plz", "thanks", "the", "ones", "one", "let's", "lets",
  "och", "vi", "tar", "ta", "väljer", "välj", "nummer", "rätt", "rätter", "rätterna", "tack", "gärna",
  "yes", "ok", "okay", "order", "them", "these", "ja", "beställ", "kör",
]);
const ORDER = new Set(["yes", "ok", "okay", "order", "ja", "beställ", "kör"]);

// "1, 3, 5", "pick 2 and 4", "vi tar 1 och 6", "1 3 5 yes": the dishes'
// numbers, and whether the message also asks to order them. Null when the
// message is anything else, which then goes to Claude.
export function parsePicks(text: string, dishCount: number): { numbers: number[]; order: boolean } | null {
  const tokens = text.toLowerCase().replace(/[’]/g, "'").split(/[\s,;.:!&+/]+|(?<=\d)-|-(?=\d)/).filter(Boolean);
  const numbers: number[] = [];
  let order = false;
  for (const t of tokens) {
    if (/^#?\d{1,2}$/.test(t)) {
      const n = Number(t.replace("#", ""));
      if (n < 1 || n > dishCount) return null;
      if (!numbers.includes(n)) numbers.push(n);
    } else if (FILLER.has(t)) {
      if (ORDER.has(t)) order = true;
    } else {
      return null;
    }
  }
  return numbers.length ? { numbers: numbers.sort((a, b) => a - b), order } : null;
}

// Picks exactly the numbered dishes (1-based, in the plan's order) and
// unpicks the rest.
export function setPicks(ctx: Context, week: Week, numbers: number[], by: string): Dish[] {
  const dishes = ctx.store.dishes(week.id);
  ctx.store.transaction(() => {
    dishes.forEach((d, i) => ctx.store.pickDish(d.id, numbers.includes(i + 1), by));
  });
  return pickedDishes(ctx, ctx.store.week(week.id)!);
}

// Before ordering: removes the planner's dishes nobody picked, with their
// ingredients.
export function dropUnpicked(ctx: Context, week: Week, by: string): Dish[] {
  if (!picksDishes(ctx.household)) return [];
  const dropped = ctx.store.dishes(week.id).filter((d) => !isPicked(d));
  ctx.store.transaction(() => {
    for (const d of dropped) ctx.store.removeDish(d.id, by);
  });
  return dropped;
}

// "Picked 1. Chili and 3. Curry" for replies.
export function describePicks(ctx: Context, week: Week, by: string): string {
  const all = ctx.store.dishes(week.id);
  const picked = all.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => isPicked(d));
  const who = memberByLogin(ctx.household, by)?.name ?? by;
  if (!picked.length) return `${who} unpicked every dish: nothing is picked now.`;
  return `${who} picked ${picked.map(({ d, n }) => `${n}. ${d.name}`).join(", ")}.`;
}
