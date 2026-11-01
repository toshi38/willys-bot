import type { Context } from "../core/context.ts";
import type { Dish, Week } from "../core/store.ts";
import { orderedWeeks } from "../mcp/tools.ts";
import { sendToMembers } from "../notify/email.ts";
import type { SlackButton } from "../notify/slack.ts";
import { localDate, nextPickup, postToWeek, toSlack } from "./week.ts";

// Once a week, the day before the next pickup, food-bot asks how the food
// from the last pickup was: in Slack, one post per dish with 1 to 5 star
// buttons, and by email, answered with scores and comments in words. The
// ratings go to the planner, which brings back what the household loved
// and drops what it did not.

// From this hour (local time) on the day before pickup.
export const SURVEY_HOUR = 10;

const surveyKey = (weekId: string) => `week.${weekId}.survey`;

// The week to ask about now, if the survey is due and not sent: the latest
// ordered week whose pickup has passed and that has dishes.
export function surveyDue(ctx: Context, now = new Date()): Week | null {
  const pickup = nextPickup(ctx.household, now);
  const eve = new Date(pickup.getFullYear(), pickup.getMonth(), pickup.getDate() - 1);
  if (localDate(now) !== localDate(eve) || now.getHours() < SURVEY_HOUR) return null;
  return lastEaten(ctx, now);
}

// The latest ordered week picked up before today with dishes and no survey
// yet.
export function lastEaten(ctx: Context, now = new Date()): Week | null {
  const week = orderedWeeks(ctx.store, 6).find((w) => w.status === "applied" && w.id < localDate(now));
  if (!week || !ctx.store.dishes(week.id).length || ctx.store.get(surveyKey(week.id))) return null;
  return week;
}

// Sends the survey when it is due, once per week. With force, sends it now
// for the last week eaten.
export async function sendSurvey(ctx: Context, opts: { force?: boolean; now?: Date } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  const week = opts.force ? lastEaten(ctx, now) : surveyDue(ctx, now);
  if (!week || !ctx.store.claim(surveyKey(week.id), now.toISOString())) return null;
  const dishes = ctx.store.dishes(week.id);
  const label = new Date(`${week.id}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  await sendToMembers(ctx.household, {
    subject: `How was the food from ${label}? [wb:${week.token}]`,
    markdown: [
      `How was the food from the pickup on ${label}?`,
      "",
      ...dishes.map((d, i) => `${i + 1}. **${d.name}**${d.origin ? ` (wildcard from ${d.origin})` : ""}`),
      "",
      "Reply with a score from 1 to 5 for each dish you cooked, and anything you want to say about it, for example **1: 4, a bit too salty** and **3: 5**. Leave out the ones you did not cook. The ratings help me suggest more of what you like.",
    ].join("\n"),
  });
  await toSlack(async () => {
    await postToWeek(ctx, `**How was the food from ${label}?**\nRate each dish you cooked from 1 to 5 with the buttons. Reply in this thread to add a comment, like "the curry was too salty".`, { broadcast: true });
    for (const d of dishes) await postToWeek(ctx, ratingText(ctx, d), { buttons: ratingButtons(d) });
  });
  return `Asked how the food from ${week.id} was (${dishes.length} dishes)`;
}

// A dish's survey post: its name and the ratings so far.
export function ratingText(ctx: Context, d: Dish, notCooked = false): string {
  const ratings = ctx.store.dishRatings(d.id);
  const scores = ratings.map((r) => `${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} ${r.member}${r.comment ? ` ("${r.comment}")` : ""}`);
  const state = notCooked ? "not cooked" : scores.length ? scores.join(", ") : "not rated yet";
  return `**${d.name}**${d.origin ? ` 🌍 ${d.origin}` : ""}: ${state}`;
}

export function ratingButtons(d: Dish): SlackButton[] {
  return [
    ...[1, 2, 3, 4, 5].map((n) => ({ action: "dish.rate", label: `${n} ★`, value: `${d.id}:${n}`, ...(n === 5 ? { style: "primary" as const } : {}) })),
    { action: "dish.notcooked", label: "Didn't cook it", value: String(d.id) },
  ];
}
