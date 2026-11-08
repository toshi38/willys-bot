import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import type { Product } from "../willys/types.ts";
import { checkDraft, writeDraft, type Draft } from "./planner.ts";
import { decide, renderWeek, syncCart } from "./weekly.ts";
import { sampleRecipe } from "../recipes/sample.ts";

const household = {
  id: "test",
  dir: "/nonexistent",
  preferences: "",
  config: {
    name: "Test",
    members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }],
    pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" },
    mail: { address: "food@ai.lau.engineering", name: "food-bot", secret: "test" },
    plan: { meals: 2, portionsPerMeal: 6, people: 2, language: "en" },
  },
} as unknown as Household;

const WEEK = "2026-10-30";
const product = (code: string, name: string, price: number): Product => ({ code, name, displayVolume: "", priceValue: price });

function setup(): { store: Store; ctx: Context } {
  const store = new Store(":memory:");
  for (const [code, name, price] of [
    ["SKYR_ST", "Skyr 400g", 18.9],
    ["CHICKEN_ST", "Kycklinglårfilé 700g", 67.9],
    ["RICE_ST", "Jasminris 1kg", 29.9],
    ["BEEF_ST", "Nötfärs 500g", 59.9],
    ["BEANS_ST", "Kidneybönor 380g", 12.9],
  ] as const) {
    store.recordProduct(product(code, name, price), "regular");
  }
  return { store, ctx: { store, household } as unknown as Context };
}

const recipe = sampleRecipe(6);

function goodDraft(listItemId: number): Draft {
  return {
    summary: "Two strong, lower calorie dishes built around this week's chicken and mince offers.",
    dishes: [
      { name: "Chicken curry", portions: 6, why: "Thigh fillet on offer", origin: "", recipeId: 0, recipe },
      { name: "Chili con carne", portions: 6, why: "Lean mince", origin: "", recipeId: 0, recipe: sampleRecipe(6, "mince") },
    ],
    lines: [
      { productCode: "SKYR_ST", qty: 1, reason: "Carin's skyr", dish: 0, listItemIds: [listItemId], restocks: "" },
      { productCode: "CHICKEN_ST", qty: 2, reason: "Curry", dish: 1, listItemIds: [], restocks: "" },
      { productCode: "BEEF_ST", qty: 2, reason: "Chili", dish: 2, listItemIds: [], restocks: "" },
      { productCode: "BEANS_ST", qty: 2, reason: "Chili", dish: 2, listItemIds: [], restocks: "" },
      { productCode: "RICE_ST", qty: 1, reason: "Restock", dish: 0, listItemIds: [], restocks: "rice" },
    ],
    skipped: [],
    notes: "",
  };
}

function openWeekWithDraft() {
  const { store, ctx } = setup();
  const skyr = store.addListItem({ text: "skyr", addedBy: "Carin" });
  store.claimWeek(WEEK);
  writeDraft(ctx, WEEK, goodDraft(skyr.id));
  store.updateWeek(WEEK, { status: "open" });
  // Adding the list item is logged; start the week with an empty log.
  store.claimChanges();
  return { store, ctx, skyr };
}

const noFixed = { fixed: [], keptDishes: [], instructions: null, replacing: [] };

test("the placeholder plan sent on 21 October fails the checks", () => {
  const { store, ctx } = setup();
  store.addListItem({ text: "milk", addedBy: "Stephen" });
  const placeholder: Draft = {
    summary: "draft",
    dishes: [],
    lines: [
      { productCode: "CHICKEN_ST", qty: 2, reason: "", dish: 0, listItemIds: [], restocks: "" },
      { productCode: "960257_PLACEHOLDER", qty: 1, reason: "", dish: 0, listItemIds: [], restocks: "" },
    ],
    skipped: [],
    notes: "draft",
  };
  const problems = checkDraft(ctx, placeholder, noFixed);
  assert.ok(problems.some((p) => /summary/.test(p)));
  assert.ok(problems.some((p) => /exactly 2 dishes/.test(p)));
  assert.ok(problems.some((p) => /960257_PLACEHOLDER is unknown/.test(p)));
  assert.ok(problems.some((p) => /milk\) is neither bought nor skipped/.test(p)));
});

test("a complete draft passes, and every open list item must be bought or skipped", () => {
  const { store, ctx } = setup();
  const skyr = store.addListItem({ text: "skyr", addedBy: "Carin" });
  assert.deepEqual(checkDraft(ctx, goodDraft(skyr.id), noFixed), []);
  const missing = { ...goodDraft(skyr.id), lines: goodDraft(skyr.id).lines.slice(1) };
  assert.deepEqual(checkDraft(ctx, missing, noFixed), ["List item #1 (skyr) is neither bought nor skipped."]);
});

test("a written draft records where each item comes from, and saves the recipes", () => {
  const { store, skyr } = openWeekWithDraft();
  const items = store.items(WEEK);
  const dishes = store.dishes(WEEK);
  const bySource = (s: string) => items.filter((i) => i.source === s).map((i) => i.productCode);
  assert.deepEqual(bySource("request"), ["SKYR_ST"]);
  assert.deepEqual(bySource("dish"), ["CHICKEN_ST", "BEEF_ST", "BEANS_ST"]);
  assert.deepEqual(bySource("staple"), ["RICE_ST"]);
  assert.equal(items[0].requestedBy, "Carin");
  assert.equal(items.find((i) => i.productCode === "BEANS_ST")?.dishId, dishes[1].id);
  assert.deepEqual(store.recipe(dishes[0].recipeId!)?.structured, recipe);
  assert.match(store.recipe(dishes[0].recipeId!)!.method, /^1\. Chop the onion\.\n2\. Brown the chicken/);
  assert.equal(store.listItems().length, 0);
  assert.equal(store.listItems(["planned"])[0].id, skyr.id);
  // Writing the draft is not a change the household needs to be told about.
  assert.equal(store.week(WEEK)?.version, 0);
  assert.deepEqual(store.claimChanges(), []);
});

test("changing one item leaves every other item exactly as it was", () => {
  const { store } = openWeekWithDraft();
  const before = store.items(WEEK);
  const skyr = before.find((i) => i.productCode === "SKYR_ST")!;
  store.setItemQuantity(skyr.id, 2, "Carin");
  const after = store.items(WEEK);
  assert.equal(after.find((i) => i.id === skyr.id)?.qty, 2);
  assert.deepEqual(
    after.filter((i) => i.id !== skyr.id),
    before.filter((i) => i.id !== skyr.id),
  );
  assert.equal(store.week(WEEK)?.version, 1);
  assert.deepEqual(store.claimChanges().map((c) => `${c.by} ${c.text}`), ["Carin changed Skyr 400g from 1 to 2"]);
});

test("removing a dish takes its ingredients with it but keeps requests", () => {
  const { store } = openWeekWithDraft();
  const [curry] = store.dishes(WEEK);
  const chicken = store.items(WEEK).find((i) => i.productCode === "CHICKEN_ST")!;
  const request = store.addItem(WEEK, { productCode: "BEANS_ST", qty: 1, source: "request", requestedBy: "Carin", dishId: curry.id }, "Carin");
  store.removeDish(curry.id, "Stephen");
  const left = store.items(WEEK);
  assert.equal(left.some((i) => i.id === chicken.id), false);
  assert.equal(left.find((i) => i.id === request.id)?.dishId, null);
  assert.deepEqual(store.dishes(WEEK).map((d) => d.name), ["Chili con carne"]);
  assert.ok(left.some((i) => i.productCode === "SKYR_ST"));
});

test("the plan shows requests with who asked, then each dish's ingredients, then basics", () => {
  const { ctx } = openWeekWithDraft();
  const text = renderWeek(ctx, ctx.store.week(WEEK)!);
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("**Asked for**") < at("**For Chicken curry**"));
  assert.ok(at("**For Chili con carne**") < at("**Basics and restocks**"));
  assert.match(text, /1 x Skyr 400g, 18.90 kr\. Carin's skyr \(Carin\)/);
});

test("only one process drafts a week, and a decision cannot race a redraft", () => {
  const dir = mkdtempSync(join(tmpdir(), "db-"));
  const a = new Store(join(dir, "db.sqlite"));
  const b = new Store(join(dir, "db.sqlite"));
  assert.equal(a.claimWeek(WEEK), true);
  assert.equal(b.claimWeek(WEEK), false);
  a.updateWeek(WEEK, { status: "open" });
  assert.equal(a.switchWeek(WEEK, "open", "drafting"), true);
  assert.equal(b.switchWeek(WEEK, "open", "skipped"), false);
});

test("skipping a week records who decided and closes it to changes", async () => {
  const { store, ctx } = openWeekWithDraft();
  await decide(ctx, store.week(WEEK)!, "skip", "carin@lau.engineering");
  assert.equal(store.week(WEEK)?.status, "skipped");
  assert.equal(store.openWeek(), null);
  await assert.rejects(decide(ctx, store.week(WEEK)!, "approve", "carin@lau.engineering"), /skipped, not waiting/);
});

test("skipping a week puts its list items back on the list, even two on one line", async () => {
  const { store, ctx } = setup();
  const a = store.addListItem({ text: "milk", addedBy: "Carin" });
  const b = store.addListItem({ text: "mjölk", addedBy: "Stephen" });
  const d = goodDraft(a.id);
  d.lines[0] = { ...d.lines[0], listItemIds: [a.id, b.id] };
  store.claimWeek(WEEK);
  writeDraft(ctx, WEEK, d);
  store.switchWeek(WEEK, "drafting", "open");
  assert.deepEqual(store.listItems(["planned"]).map((i) => i.id), [a.id, b.id]);
  await decide(ctx, store.week(WEEK)!, "skip", "carin@lau.engineering");
  assert.deepEqual(store.listItems().map((i) => i.id), [a.id, b.id]);
});

test("a filled cart marks every list item the week took on as ordered", () => {
  const { store } = openWeekWithDraft();
  store.orderListItems(WEEK);
  assert.equal(store.listItems(["ordered"]).length, 1);
  assert.equal(store.listItems(["planned"]).length, 0);
});

test("removing a request takes its list item off the list", () => {
  const { store, skyr } = openWeekWithDraft();
  const request = store.items(WEEK).find((i) => i.source === "request")!;
  store.removeItem(request.id, "Carin");
  assert.equal(store.listItems(["removed"])[0].id, skyr.id);
});

test("a week left drafting by a process that died counts as abandoned", () => {
  const { store } = setup();
  store.claimWeek(WEEK);
  assert.equal(store.draftAbandoned(WEEK), false);
  assert.equal(store.draftAbandoned(WEEK, -1), true);
  store.switchWeek(WEEK, "drafting", "open");
  assert.equal(store.draftAbandoned(WEEK, -1), false);
});

test("saving a recipe with a known name keeps the old one for past weeks", () => {
  const { store } = setup();
  const first = store.saveRecipe({ name: "Chili", ingredients: "beef", method: "old" }, "planner");
  const second = store.saveRecipe({ name: "Chili", ingredients: "beef, beans", method: "new" }, "planner");
  assert.notEqual(first.id, second.id);
  assert.equal(store.recipe(first.id)?.method, "old");
});

test("an announcement is never marked shown for an older version", () => {
  const { store } = openWeekWithDraft();
  store.markAnnounced(WEEK, 3);
  store.markAnnounced(WEEK, 2);
  assert.equal(store.week(WEEK)?.announcedVersion, 3);
});

test("an approved week's cart is set to its items, with removed products taken out", async () => {
  const { store, ctx } = openWeekWithDraft();
  const set: { code: string; qty: number }[][] = [];
  const willys = { setCartQuantities: async (lines: { code: string; qty: number }[]) => (set.push(lines), { products: [], totalPrice: "100 kr" }) };
  const c = { ...ctx, willys } as unknown as Context;
  store.updateWeek(WEEK, { status: "applied" });
  const beans = store.items(WEEK).find((i) => i.productCode === "BEANS_ST")!;
  store.removeItem(beans.id, "Stephen");
  store.addItem(WEEK, { productCode: "BEEF_ST", qty: 1, source: "request", requestedBy: "Stephen" }, "Stephen");
  await syncCart(c, store.week(WEEK)!);
  const lines = Object.fromEntries(set[0].map((l) => [l.code, l.qty]));
  assert.deepEqual(lines, { SKYR_ST: 1, CHICKEN_ST: 2, BEEF_ST: 3, BEANS_ST: 0, RICE_ST: 1 });
  assert.equal(store.week(WEEK)?.announcedVersion, store.week(WEEK)?.version);
});

test("the current week is the nearest one not yet picked up, approved weeks included", () => {
  const { store } = openWeekWithDraft();
  store.updateWeek(WEEK, { status: "applied" });
  assert.equal(store.currentWeek("2026-10-29")?.id, WEEK);
  assert.equal(store.currentWeek("2026-10-30")?.id, WEEK);
  assert.equal(store.currentWeek("2026-10-31"), null);
});

test("a draft breaking the household's brand or gluten rules, or far over budget, is rejected", () => {
  const { store, ctx } = setup();
  const ruled = { ...ctx, household: { ...household, config: { ...household.config, rules: { avoidBrands: ["Garant"], avoid: [], glutenFree: true, staples: [] }, plan: { ...household.config.plan, budgetSek: 300 } } } } as unknown as Context;
  store.recordProduct({ code: "GARANT_ST", name: "Krossade tomater", manufacturer: "Garant", priceValue: 9.9 }, "regular");
  store.recordProduct({ code: "PASTA_ST", name: "Spaghetti 1kg", priceValue: 19.9 }, "regular");
  const d = goodDraft(0);
  d.lines = d.lines.filter((l) => l.listItemIds.length === 0);
  d.lines.push({ productCode: "GARANT_ST", qty: 2, reason: "Tomatoes", dish: 2, listItemIds: [], restocks: "" });
  d.lines.push({ productCode: "PASTA_ST", qty: 1, reason: "Pasta", dish: 1, listItemIds: [], restocks: "" });
  const problems = checkDraft(ruled, d, noFixed).join("\n");
  assert.match(problems, /breaks the household rule "avoid Garant"/);
  assert.match(problems, /Spaghetti 1kg .* contains gluten/);
  assert.match(problems, /well over the 300 kr budget/);
  d.lines.at(-2)!.reason = "Brand exception: every other tomato costs more than double";
  d.lines.at(-1)!.reason = "Gluten checked: corn and rice spaghetti";
  assert.doesNotMatch(checkDraft(ruled, d, noFixed).join("\n"), /household rule|gluten/);
});
