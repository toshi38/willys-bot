import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { dropUnpicked, parsePicks, pickedDishes, pickProblem, setPicks } from "./picks.ts";
import { renderWeek } from "./weekly.ts";

const WEEK = "2026-10-30";
const household = (plan: Record<string, unknown> = {}) =>
  ({ id: "t", dir: "/x", preferences: "", config: { name: "T", members: [{ name: "Carin", email: "carin@x.se" }], plan: { meals: 2, suggestions: 4, wildcard: true, portionsPerMeal: 4, people: 2, language: "en", ...plan } } }) as unknown as Household;

function week(plan?: Record<string, unknown>) {
  const store = new Store(":memory:");
  const ctx = { store, household: household(plan) } as unknown as Context;
  store.recordProduct({ code: "A_ST", name: "A", priceValue: 10 } as never, "regular");
  store.claimWeek(WEEK);
  const dishes = ["Chili", "Curry", "Khachapuri", "Soup"].map((name) => store.addDish(WEEK, { name, portions: 4, origin: name === "Khachapuri" ? "Georgia" : null }, "planner"));
  for (const d of dishes) store.addItem(WEEK, { productCode: "A_ST", qty: 1, source: "dish", dishId: d.id }, "planner");
  store.addItem(WEEK, { productCode: "A_ST", qty: 2, source: "staple" }, "planner");
  store.addItem(WEEK, { productCode: "A_ST", qty: 3, source: "request", requestedBy: "Carin" }, "Carin");
  store.switchWeek(WEEK, "drafting", "open");
  return { store, ctx, dishes, w: () => store.week(WEEK)! };
}

test("numbers read as picks, with or without a yes; anything else goes to Claude", () => {
  const p = (t: string) => parsePicks(t, 6);
  assert.deepEqual(p("1, 3, 5"), { numbers: [1, 3, 5], order: false });
  assert.deepEqual(p("pick 5 and 2"), { numbers: [2, 5], order: false });
  assert.deepEqual(p("Vi tar 1 och 6, tack!"), { numbers: [1, 6], order: false });
  assert.deepEqual(p("1 3 5 yes"), { numbers: [1, 3, 5], order: true });
  assert.deepEqual(p("#2 #4"), { numbers: [2, 4], order: false });
  assert.deepEqual(p("2-4"), { numbers: [2, 4], order: false });
  assert.equal(p("7"), null, "out of range");
  assert.equal(p("0"), null);
  assert.equal(p("2 kg chicken please"), null);
  assert.equal(p("swap 2 for something with fish"), null);
  assert.equal(p("yes"), null, "a plain yes is an approval, not a pick");
  assert.equal(p("no 3"), null);
});

test("picking sets exactly the numbered dishes; ordering needs one", () => {
  const { ctx, w } = week();
  assert.match(pickProblem(ctx, w()) ?? "", /Pick the dishes you want to cook first/);
  setPicks(ctx, w(), [1, 3], "carin@x.se");
  assert.deepEqual(pickedDishes(ctx, w()).map((d) => d.name), ["Chili", "Khachapuri"]);
  setPicks(ctx, w(), [2], "carin@x.se");
  assert.deepEqual(pickedDishes(ctx, w()).map((d) => d.name), ["Curry"]);
  assert.equal(pickProblem(ctx, w()), null);
  assert.ok(w().version > 0, "picks count as changes, so the plan is shown again");
});

test("a dish a member added counts as picked, and households that order everything never pick", () => {
  const { store, ctx, w } = week();
  store.addDish(WEEK, { name: "Tacos", portions: 4 }, "Carin");
  assert.equal(pickProblem(ctx, w()), null);
  const all = week({ suggestions: 2 });
  assert.equal(pickProblem(all.ctx, all.w()), null);
  assert.deepEqual(dropUnpicked(all.ctx, all.w(), "food-bot"), []);
});

test("before ordering, unpicked dishes go with their ingredients; requests and basics stay", () => {
  const { store, ctx, w } = week();
  setPicks(ctx, w(), [2], "carin@x.se");
  assert.deepEqual(dropUnpicked(ctx, w(), "food-bot").map((d) => d.name), ["Chili", "Khachapuri", "Soup"]);
  assert.deepEqual(store.dishes(WEEK).map((d) => d.name), ["Curry"]);
  assert.deepEqual(store.items(WEEK).map((i) => [i.source, i.qty]), [["dish", 1], ["staple", 2], ["request", 3]]);
});

test("while picking, the plan numbers the suggestions with their cost and shows what would be bought", () => {
  const { ctx, w } = week();
  let text = renderWeek(ctx, w());
  assert.match(text, /## Suggestions\n1\. \*\*Chili\*\* \(4 portions, about 10 kr\)\. Good|## Suggestions\n1\. \*\*Chili\*\* \(4 portions, about 10 kr\)\./);
  assert.match(text, /3\. \*\*Khachapuri\*\* \(4 portions, about 10 kr\)\. 🌍 \*Wildcard from Georgia\.\*/);
  assert.match(text, /## Shopping for the basics, until you pick dishes \(about 50 kr\)/);
  assert.doesNotMatch(text, /\*\*For Chili\*\*/);
  setPicks(ctx, w(), [1], "carin@x.se");
  text = renderWeek(ctx, w());
  assert.match(text, /1\. ✅ \*\*Chili\*\*/);
  assert.match(text, /## Shopping for the basics and the 1 picked dish \(about 60 kr\)/);
  assert.match(text, /\*\*For Chili\*\*/);
});

test("ratings: one per member and dish, replaced when rated again, summed up per recipe", () => {
  const store = new Store(":memory:");
  store.claimWeek(WEEK);
  const r = store.saveRecipe({ name: "Chili", ingredients: "x", method: "y" }, "planner");
  const d = store.addDish(WEEK, { name: "Chili", portions: 4, recipeId: r.id }, "planner");
  store.rateDish(d.id, "Carin", 3, "too mild");
  store.rateDish(d.id, "Carin", 4);
  store.rateDish(d.id, "Stephen", 5, "great");
  assert.deepEqual(store.dishRatings(d.id).map((x) => [x.member, x.stars, x.comment]), [["Carin", 4, "too mild"], ["Stephen", 5, "great"]]);
  assert.deepEqual(store.recipeRatings().map((x) => ({ ...x, last: "" })), [{ recipeId: r.id, name: "Chili", average: 4.5, count: 2, comments: ["great", "too mild"], last: "" }]);
  assert.throws(() => store.rateDish(d.id, "Carin", 6), /1 to 5/);
  assert.throws(() => store.rateDish(999, "Carin", 3), /No dish 999/);
});
