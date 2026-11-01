import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import type { Product } from "../willys/types.ts";
import { buildPrompt, checkDraft, openRequests, type Draft, type DraftInput } from "./planner.ts";

const WEEK = "2026-10-30";

function household(plan: Record<string, unknown>, preferences = ""): Household {
  return {
    id: "test",
    dir: "/nonexistent",
    preferences,
    config: { name: "Lau", members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }], plan: { meals: 3, portionsPerMeal: 4, people: 2, language: "en", ...plan } },
  } as unknown as Household;
}

const product = (code: string, name: string, price: number, over: Partial<Product> = {}): Product => ({ code, name, displayVolume: "", priceValue: price, ...over });

const none: DraftInput = { fixed: [], keptDishes: [], instructions: null, replacing: [] };

// The text of one "## <heading>" section of the prompt.
const section = (prompt: string, heading: string) => prompt.split(`## ${heading}`)[1]?.split("\n\n")[0] ?? null;

test("an empty household gets a prompt that says what is missing", () => {
  const ctx = { store: new Store(":memory:"), household: household({}) } as unknown as Context;
  const prompt = buildPrompt(ctx, WEEK, none);
  assert.match(prompt, /^Household: Lau\. 2 people\. Plan 3 dishes of about 4 portions each\. Language: English\.\n/);
  assert.match(prompt, new RegExp(`This shop is picked up on ${WEEK}\\.`));
  assert.equal(section(prompt, "Preferences"), "\n(none written yet)");
  assert.match(section(prompt, "Pantry (at home)") ?? "", /\(not recorded yet: assume a normal stocked kitchen/);
  assert.equal(section(prompt, "Open shopping list"), "\n(empty)");
  assert.equal(section(prompt, "Recent dishes (newest first)"), "\n(none yet)");
  assert.equal(section(prompt, "Known recipes (id: name)"), "\n(none yet)");
  assert.match(prompt, /\(no snapshot yet: use search_products and current_offers\)$/);
  for (const heading of ["Already in this week's shop", "Dishes staying", "Dishes being replaced", "What the household asked for"]) {
    assert.doesNotMatch(prompt, new RegExp(heading), heading);
  }
});

test("the prompt carries the household's preferences, pantry, list, history, recipes and offers", () => {
  const store = new Store(":memory:");
  const ctx = { store, household: household({ budgetSek: 1500, language: "sv" }, "No coriander, ever.") } as unknown as Context;
  store.setPantryItem({ name: "rice", status: "low", quantity: "200 g", note: "jasmine", updatedBy: "Carin" });
  store.setPantryItem({ name: "salt", status: "have", updatedBy: "Carin" });
  store.addListItem({ text: "milk", quantity: "2", note: "lactose free", productCode: "MILK_ST", addedBy: "Carin" });
  store.addListItem({ text: "eggs", addedBy: "Stephen" });
  store.claimWeek("2026-10-23");
  store.updateWeek("2026-10-23", { status: "applied" });
  store.addDish("2026-10-23", { name: "Fish tacos", portions: 4 }, "planner");
  store.claimWeek("2026-10-16");
  store.updateWeek("2026-10-16", { status: "skipped" });
  store.addDish("2026-10-16", { name: "Lentil soup", portions: 4 }, "planner");
  const recipe = store.saveRecipe({ name: "Chicken curry", ingredients: "chicken", method: "cook" }, "planner");
  store.recordProduct(product("KAFFE_ST", "Kaffe", 67.9, { displayVolume: "450g", potentialPromotions: [{ rewardLabel: "49,90/st", conditionLabel: "Max 2", qualifyingCount: 1 }] }), "online-promo");

  const prompt = buildPrompt(ctx, WEEK, none);
  assert.match(prompt, /^Household: Lau\. 2 people\. Plan 3 dishes of about 4 portions each\. Budget about 1500 kr\. Language: Swedish\.\n/);
  assert.equal(section(prompt, "Preferences"), "\nNo coriander, ever.");
  assert.equal(section(prompt, "Pantry (at home)"), "\n- rice: low, 200 g (jasmine)\n- salt: have");
  const list = store.listItems();
  assert.equal(section(prompt, "Open shopping list"), `\n- #${list[0].id} milk x 2 (lactose free) [pinned MILK_ST], added by Carin\n- #${list[1].id} eggs, added by Stephen`);
  assert.equal(section(prompt, "Recent dishes (newest first)"), "\n- 2026-10-23: Fish tacos (ordered)\n- 2026-10-16: Lentil soup");
  assert.equal(section(prompt, "Known recipes (id: name)"), `\n- ${recipe.id}: Chicken curry`);
  assert.match(prompt, /\nKAFFE_ST \| Kaffe \| 450g \| 49\.9 \| 67\.9 \| Max 2 49,90\/st$/);
});

test("a redraft lists the fixed items, the dishes staying and going, and what was asked for", () => {
  const store = new Store(":memory:");
  const ctx = { store, household: household({ meals: 3 }) } as unknown as Context;
  store.recordProduct(product("SKYR_ST", "Skyr 400g", 18.9), "regular");
  const skyr = store.addListItem({ text: "skyr", addedBy: "Carin" });
  const eggs = store.addListItem({ text: "eggs", addedBy: "Stephen" });
  store.claimWeek(WEEK);
  store.addItem(WEEK, { productCode: "SKYR_ST", qty: 2, source: "request", requestedBy: "Carin", listItemId: skyr.id }, "Carin");
  store.addItem(WEEK, { productCode: "UNSEEN_ST", qty: 1, source: "staple" }, "planner");
  const fixed = store.items(WEEK);

  const prompt = buildPrompt(ctx, WEEK, { fixed, keptDishes: ["Chicken curry"], instructions: "More vegetarian food", replacing: ["Fish tacos", "Chili"] });
  assert.match(prompt, /Plan 2 dishes of about 4 portions each/);
  assert.equal(section(prompt, "Open shopping list"), `\n- #${eggs.id} eggs, added by Stephen`);
  assert.equal(section(prompt, "Already in this week's shop (fixed)"), "\n- 2 x Skyr 400g [SKYR_ST], asked for by Carin\n- 1 x UNSEEN_ST [UNSEEN_ST]");
  assert.equal(section(prompt, "Dishes staying this week (already bought for; plan only the rest)"), "\n- Chicken curry");
  assert.equal(section(prompt, "Dishes being replaced (do not plan these again)"), "\n- Fish tacos\n- Chili");
  assert.match(prompt, /\n## What the household asked for \(follow it\)\nMore vegetarian food$/);
});

test("kept dishes never ask for fewer than zero dishes", () => {
  const ctx = { store: new Store(":memory:"), household: household({ meals: 1 }) } as unknown as Context;
  assert.match(buildPrompt(ctx, WEEK, { ...none, keptDishes: ["Curry", "Chili"] }), /Plan 0 dishes/);
});

test("the open requests are the list items not already in the week", () => {
  const store = new Store(":memory:");
  const ctx = { store, household: household({}) } as unknown as Context;
  store.recordProduct(product("SKYR_ST", "Skyr 400g", 18.9), "regular");
  const skyr = store.addListItem({ text: "skyr", addedBy: "Carin" });
  const eggs = store.addListItem({ text: "eggs", addedBy: "Carin" });
  store.claimWeek(WEEK);
  store.addItem(WEEK, { productCode: "SKYR_ST", qty: 1, source: "request", listItemId: skyr.id }, "Carin");
  store.addItem(WEEK, { productCode: "SKYR_ST", qty: 1, source: "staple" }, "planner");
  assert.deepEqual(openRequests(ctx, store.items(WEEK)).map((i) => i.id), [eggs.id]);
  assert.deepEqual(openRequests(ctx, []).map((i) => i.id), [skyr.id, eggs.id]);
});

const recipe = { servings: 4, ingredients: ["400 g beans"], method: "1. Soak the beans. 2. Simmer them for an hour." };

function redraftSetup() {
  const store = new Store(":memory:");
  const ctx = { store, household: household({ meals: 2 }) } as unknown as Context;
  store.recordProduct(product("SKYR_ST", "Skyr 400g", 18.9), "regular");
  store.recordProduct(product("BEANS_ST", "Bönor", 12.9), "regular");
  store.recordProduct(product("EGGS_ST", "Ägg 12p", 39.9), "regular");
  const skyr = store.addListItem({ text: "skyr", addedBy: "Carin" });
  const eggs = store.addListItem({ text: "eggs", addedBy: "Stephen" });
  store.claimWeek(WEEK);
  store.addItem(WEEK, { productCode: "SKYR_ST", qty: 1, source: "request", requestedBy: "Carin", listItemId: skyr.id }, "Carin");
  const input: DraftInput = { fixed: store.items(WEEK), keptDishes: ["Chicken curry"], instructions: null, replacing: [] };
  return { store, ctx, input, eggs };
}

const draft = (over: Partial<Draft>): Draft => ({
  summary: "One bean dish next to the curry that stays, with eggs for breakfast.",
  dishes: [{ name: "Bean stew", portions: 4, why: "Cheap", origin: "", recipeId: 0, recipe }],
  lines: [{ productCode: "BEANS_ST", qty: 2, reason: "Stew", dish: 1, listItemIds: [], restocks: "" }],
  skipped: [],
  notes: "",
  ...over,
});

test("a redraft plans only the dishes not kept, and covers only the list items not already in the week", () => {
  const { ctx, input, eggs } = redraftSetup();
  const eggsLine = { productCode: "EGGS_ST", qty: 1, reason: "Breakfast", dish: 0, listItemIds: [eggs.id], restocks: "" };
  const good = draft({ lines: [...draft({}).lines, eggsLine] });
  assert.deepEqual(checkDraft(ctx, good, input), []);
  assert.deepEqual(checkDraft(ctx, draft({ skipped: [{ listItemId: eggs.id, reason: "None in stock" }] }), input), []);

  const tooMany = draft({ dishes: [...good.dishes, { ...good.dishes[0], name: "Chili" }], lines: [...good.lines, { ...good.lines[0], dish: 2 }] });
  assert.deepEqual(checkDraft(ctx, tooMany, input), ["Plan exactly 1 dishes, not 2."]);

  assert.deepEqual(checkDraft(ctx, draft({}), input), [`List item #${eggs.id} (eggs) is neither bought nor skipped.`]);
});

test("with every dish kept, a redraft may plan no dishes at all", () => {
  const { ctx, input, eggs } = redraftSetup();
  const allKept = { ...input, keptDishes: ["Chicken curry", "Chili"] };
  const noDishes = draft({ dishes: [], lines: [{ productCode: "EGGS_ST", qty: 1, reason: "Breakfast", dish: 0, listItemIds: [eggs.id], restocks: "" }] });
  assert.deepEqual(checkDraft(ctx, noDishes, allKept), []);
});

test("a dish reusing a known recipe needs no recipe of its own, and lines must point at real dishes", () => {
  const { store, ctx, input, eggs } = redraftSetup();
  const known = store.saveRecipe({ name: "Bean stew", ingredients: "beans", method: "cook" }, "planner");
  const reused = draft({
    dishes: [{ name: "Bean stew", portions: 4, why: "Again", origin: "", recipeId: known.id, recipe: { servings: 0, ingredients: [], method: "" } }],
    skipped: [{ listItemId: eggs.id, reason: "None" }],
  });
  assert.deepEqual(checkDraft(ctx, reused, input), []);

  const unknownRecipe = draft({ ...reused, dishes: [{ ...reused.dishes[0], recipeId: 999 }] });
  assert.deepEqual(checkDraft(ctx, unknownRecipe, input), ["Dish 1 (Bean stew) needs a recipe."]);

  const badLine = draft({ ...reused, lines: [...reused.lines, { productCode: "EGGS_ST", qty: 1, reason: "", dish: 3, listItemIds: [], restocks: "" }] });
  assert.deepEqual(checkDraft(ctx, badLine, input), ["Line EGGS_ST points at dish 3, which does not exist."]);
});

// A household that gets 6 suggestions and cooks 3, with a wildcard.
function pickingSetup(plan: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const ctx = { store, household: household({ meals: 3, suggestions: 6, wildcard: true, ...plan }) } as unknown as Context;
  store.recordProduct(product("BEANS_ST", "Bönor", 50), "regular");
  store.recordProduct(product("RICE_ST", "Ris", 30), "regular");
  return { store, ctx };
}
const dish = (name: string, origin = "") => ({ name, portions: 4, why: "Good", origin, recipeId: 0, recipe });
const sixDishes = (wildcards: number) =>
  ["Chili", "Curry", "Stew", "Soup", "Bake", "Salad"].map((name, i) => dish(name, i < wildcards ? "Georgia" : ""));
const linesFor = (n: number, qty = 1) => Array.from({ length: n }, (_, i) => ({ productCode: "BEANS_ST", qty, reason: "x", dish: i + 1, listItemIds: [], restocks: "" }));

test("with picking, the prompt asks for the suggestions, one wildcard, and the budget for the dishes cooked", () => {
  const { ctx } = pickingSetup({ budgetSek: 900 });
  const prompt = buildPrompt(ctx, WEEK, none);
  assert.match(prompt, /Suggest 6 dishes of about 4 portions each\. The household picks about 3 of the week's suggestions to cook, and only the picked dishes are bought\./);
  assert.match(prompt, /Make exactly one of them a wildcard: home cooking from another country/);
  assert.match(prompt, /Budget about 900 kr for the basics and 3 dishes\./);
  // A redraft that keeps the picked wildcard asks for no new one.
  const kept = buildPrompt(ctx, WEEK, { ...none, keptDishes: ["Khachapuri", "Chili"], keptWildcard: true });
  assert.match(kept, /Suggest 4 dishes/);
  assert.doesNotMatch(kept, /wildcard/i);
});

test("a picking draft needs exactly one wildcard with its country", () => {
  const { ctx } = pickingSetup();
  const base = draft({ summary: "Six varied dishes around this week's bean and rice offers.", lines: linesFor(6) });
  assert.deepEqual(checkDraft(ctx, { ...base, dishes: sixDishes(1) }, none), []);
  assert.ok(checkDraft(ctx, { ...base, dishes: sixDishes(0) }, none).includes("Make exactly one dish the wildcard, with its country in origin, not 0."));
  assert.ok(checkDraft(ctx, { ...base, dishes: sixDishes(2) }, none).includes("Make exactly one dish the wildcard, with its country in origin, not 2."));
  const noWildcard = pickingSetup({ wildcard: false }).ctx;
  assert.ok(checkDraft(noWildcard, { ...base, dishes: sixDishes(1) }, none).includes("No wildcard is wanted: leave origin empty for every dish."));
  assert.ok(checkDraft(ctx, { ...base, dishes: sixDishes(1).slice(0, 5), lines: linesFor(5) }, none).includes("Plan exactly 6 dishes, not 5."));
});

test("with picking, the budget counts the basics and the average dish times the dishes cooked", () => {
  // Six dishes at 100 kr each and 30 kr of basics: 3 cooked come to 330 kr.
  const { ctx } = pickingSetup({ budgetSek: 300 });
  const lines = [...linesFor(6, 2), { productCode: "RICE_ST", qty: 1, reason: "basics", dish: 0, listItemIds: [], restocks: "" }];
  const d = draft({ summary: "Six varied dishes around this week's bean and rice offers.", dishes: sixDishes(1), lines });
  assert.deepEqual(checkDraft(ctx, d, none), [], "330 kr is within 15% of 300 kr, though all six dishes cost 630 kr");
  const tight = pickingSetup({ budgetSek: 250 }).ctx;
  assert.ok(checkDraft(tight, d, none).some((p) => /The basics and 3 average dishes come to about 330 kr, well over the 250 kr budget/.test(p)));
});

test("the prompt lists how the household rated recipes, best first, with comments", () => {
  const { store, ctx } = pickingSetup();
  store.claimWeek("2026-10-23");
  const loved = store.saveRecipe({ name: "Khachapuri", ingredients: "x", method: "y" }, "planner");
  const meh = store.saveRecipe({ name: "Bean soup", ingredients: "x", method: "y" }, "planner");
  const d1 = store.addDish("2026-10-23", { name: "Khachapuri", portions: 4, recipeId: loved.id }, "planner");
  const d2 = store.addDish("2026-10-23", { name: "Bean soup", portions: 4, recipeId: meh.id }, "planner");
  store.rateDish(d1.id, "Carin", 5, "amazing");
  store.rateDish(d1.id, "Stephen", 4);
  store.rateDish(d2.id, "Carin", 2, "bland");
  assert.equal(
    section(buildPrompt(ctx, WEEK, none), "How the household rated dishes they cooked (best first)"),
    `\n- Khachapuri (recipe ${loved.id}): 4.5 of 5 from 2 ratings: "amazing"\n- Bean soup (recipe ${meh.id}): 2 of 5 from 1 rating: "bland"`,
  );
});
