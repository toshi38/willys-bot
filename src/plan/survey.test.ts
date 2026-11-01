import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { ratingButtons, ratingText, surveyDue } from "./survey.ts";

const household = { id: "t", dir: "/x", preferences: "", config: { name: "T", members: [], pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" }, plan: { meals: 3 } } } as unknown as Household;

// Picked up on Friday 30 October; the next pickup is Friday 6 November.
function setup() {
  const store = new Store(":memory:");
  store.claimWeek("2026-10-30");
  store.addDish("2026-10-30", { name: "Chili", portions: 6 }, "planner");
  store.switchWeek("2026-10-30", "drafting", "applied");
  return { store, ctx: { store, household } as unknown as Context };
}
const local = (d: number, h: number) => new Date(2026, 10, d, h, 30);

test("the survey is due from 10:00 on the day before pickup, about the last week picked up", () => {
  const { ctx } = setup();
  assert.equal(surveyDue(ctx, local(5, 10))?.id, "2026-10-30", "Thursday 10:30");
  assert.equal(surveyDue(ctx, local(5, 9)), null, "Thursday 9:30 is too early");
  assert.equal(surveyDue(ctx, local(4, 12)), null, "Wednesday");
  assert.equal(surveyDue(ctx, local(6, 12)), null, "pickup day");
});

test("each week is asked about once, and only when it was ordered and has dishes", () => {
  const { store, ctx } = setup();
  store.set("week.2026-10-30.survey", "sent");
  assert.equal(surveyDue(ctx, local(5, 11)), null, "already asked");
  const skipped = new Store(":memory:");
  skipped.claimWeek("2026-10-30");
  skipped.addDish("2026-10-30", { name: "Chili", portions: 6 }, "planner");
  skipped.switchWeek("2026-10-30", "drafting", "skipped");
  assert.equal(surveyDue({ store: skipped, household } as unknown as Context, local(5, 11)), null, "a skipped week was not cooked");
});

test("a dish's survey post shows each member's stars, or that nobody cooked it", () => {
  const { store, ctx } = setup();
  const dish = store.dishes("2026-10-30")[0]!;
  assert.equal(ratingText(ctx, dish), "**Chili**: not rated yet");
  store.rateDish(dish.id, "Carin", 5, "perfect");
  store.rateDish(dish.id, "Stephen", 3);
  assert.equal(ratingText(ctx, dish), '**Chili**: ★★★★★ Carin ("perfect"), ★★★☆☆ Stephen');
  assert.deepEqual(ratingButtons(dish).map((b) => [b.action, b.value]), [...[1, 2, 3, 4, 5].map((n) => ["dish.rate", `${dish.id}:${n}`]), ["dish.notcooked", String(dish.id)]]);
});
