import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { sampleRecipe } from "../recipes/sample.ts";
import { buildServer } from "./tools.ts";

// Weeks relative to today, so the tests do not expire.
const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));
const NEXT = day(3);
const PAST = day(-4);

const household = { id: "test", dir: "/nonexistent", preferences: "", config: { name: "Test", members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }], plan: { meals: 3, people: 2, portionsPerMeal: 6, wildcard: false, language: "en" } } } as unknown as Household;

const ruled = { ...household, config: { ...household.config, rules: { avoidBrands: ["Garant"], avoid: [], glutenFree: true, staples: [] } } } as unknown as Household;

async function connect(store: Store, week?: string, h: Household = household) {
  const server = buildServer({ store, household: h } as unknown as Context, "Carin", { week });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: res.isError === true, text: res.content.map((c) => c.text).join("") };
  };
}

function weekWithDish(store: Store, id: string) {
  store.recordProduct({ code: "SKYR_ST", name: "Skyr", priceValue: 18.9 }, "regular");
  store.claimWeek(id);
  store.switchWeek(id, "drafting", "open");
  const recipe = store.saveRecipe({ name: "Curry", ingredients: "chicken", method: "cook it" }, "planner");
  return store.addDish(id, { name: "Curry", portions: 6, recipeId: recipe.id }, "planner");
}

test("an item added without a dish is a request from the person talking", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, NEXT);
  const call = await connect(store);
  const res = await call("week_add_item", { productCode: "SKYR_ST", qty: 2, reason: "for breakfast" });
  assert.equal(res.error, false);
  const [item] = store.items(NEXT);
  assert.deepEqual([item.source, item.requestedBy, item.qty], ["request", "Carin", 2]);
});

test("the tools refuse unknown products, removed dishes and pantry names that do not exist", async () => {
  const store = new Store(":memory:");
  const dish = weekWithDish(store, NEXT);
  const call = await connect(store);
  assert.match((await call("week_add_item", { productCode: "NOPE_ST", qty: 1, reason: "x" })).text, /Unknown product/);
  assert.match((await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x", restocks: "skyr" })).text, /No pantry entry/);
  store.removeDish(dish.id, "Carin");
  assert.match((await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x", dishId: dish.id })).text, /not in this week/);
  assert.equal(store.items(NEXT).length, 0);
});

test("pinned to a closed week, the tools change nothing, even with another week open", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, PAST);
  store.switchWeek(PAST, "open", "applied");
  weekWithDish(store, NEXT);
  const call = await connect(store, PAST);
  const res = await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x" });
  assert.match(res.text, new RegExp(`${PAST} is applied`));
  assert.equal(store.items(NEXT).length, 0);
});

test("an approved week can still be changed until its pickup day has passed", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, "2999-01-01");
  store.switchWeek("2999-01-01", "open", "applied");
  const call = await connect(store);
  assert.equal((await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x" })).error, false);
  weekWithDish(store, "2000-01-07");
  store.switchWeek("2000-01-07", "open", "applied");
  const past = await connect(store, "2000-01-07");
  assert.match((await past("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x" })).text, /is applied, so it cannot be changed/);
});

test("past_weeks finds an ordered week after its pickup, with each dish's full recipe", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, PAST);
  store.switchWeek(PAST, "open", "applied");
  weekWithDish(store, "2000-01-07");
  store.switchWeek("2000-01-07", "open", "skipped");
  const call = await connect(store);
  assert.match((await call("week_view")).text, /No week is planned/);
  const list = JSON.parse((await call("past_weeks")).text) as { pickup: string; dishes: { name: string }[] }[];
  assert.deepEqual(list.map((w) => [w.pickup, w.dishes.map((d) => d.name)]), [[PAST, ["Curry"]]]);
  const week = JSON.parse((await call("past_weeks", { pickup: PAST })).text) as { dishes: { recipe: { ingredients: string; method: string } }[] };
  assert.deepEqual(week.dishes[0].recipe && [week.dishes[0].recipe.ingredients, week.dishes[0].recipe.method], ["chicken", "cook it"]);
  assert.match((await call("past_weeks", { pickup: "2000-01-07" })).text, /No ordered week/);
});

test("only one dish can be removed per message; more means a redraft", async () => {
  const store = new Store(":memory:");
  const first = weekWithDish(store, NEXT);
  const second = store.addDish(NEXT, { name: "Chili", portions: 6, recipeId: first.recipeId }, "planner");
  const call = await connect(store);
  assert.equal((await call("dish_remove", { dishId: first.id })).error, false);
  const again = await call("dish_remove", { dishId: second.id });
  assert.equal(again.error, true);
  assert.match(again.text, /Only one dish can be removed per message/);
  assert.deepEqual(store.dishes(NEXT).map((d) => d.name), ["Chili"]);
});

test("an avoided brand or a gluten risk is refused unless the exception is stated, and gluten only for a dish", async () => {
  const store = new Store(":memory:");
  const dish = weekWithDish(store, NEXT);
  store.recordProduct({ code: "GARANT_ST", name: "Päron Kvarg 900g", manufacturer: "Garant", priceValue: 29.9 }, "regular");
  store.recordProduct({ code: "SOY_ST", name: "Japansk Soja 150ml", priceValue: 24.9 }, "regular");
  const call = await connect(store, undefined, ruled);
  assert.match((await call("week_add_item", { productCode: "GARANT_ST", qty: 1, reason: "kvarg" })).text, /breaks the household rule "avoid Garant"/);
  assert.match((await call("week_add_item", { productCode: "SOY_ST", qty: 1, reason: "stir fry", dishId: dish.id })).text, /contains gluten/);
  assert.equal(store.items(NEXT).length, 0);
  assert.equal((await call("week_add_item", { productCode: "GARANT_ST", qty: 1, reason: "Brand exception: Arla is sold out" })).error, false);
  // A member's own request is bought as asked: they know who it is for.
  assert.equal((await call("week_add_item", { productCode: "SOY_ST", qty: 1, reason: "for my noodles" })).error, false);
  assert.equal(store.items(NEXT).length, 2);
});

test("gluten is judged from the product's Willys ingredients when it has them", async () => {
  const store = new Store(":memory:");
  const dish = weekWithDish(store, NEXT);
  const pages: Record<string, { ingredients: string | null; labels: string[] }> = {
    SAKURA_ST: { ingredients: "Vatten, SOJABÖNOR, majsmjöl, salt.", labels: [] },
    KIKKO_ST: { ingredients: "Vatten, SOJABÖNOR, VETE, salt.", labels: [] },
    CRISP_ST: { ingredients: "SOJAolja, chili, lök, salt.", labels: [] },
  };
  const codes = Object.keys(pages);
  for (const code of codes) store.recordProduct({ code, name: code === "CRISP_ST" ? "Crispy Chili In Oil" : "Japansk Soja", priceValue: 25 }, "regular");
  const fetched: string[] = [];
  const willys = {
    productInfo: async (code: string) => (fetched.push(code), { code, name: code, brand: null, size: null, category: "Skafferi", diet: null, description: null, origin: null, ...pages[code] }),
    search: async () => ({ results: codes.map((code) => ({ code, name: store.productName(code), priceValue: 25 })), pagination: { numberOfPages: 1 } }),
  };
  const server = buildServer({ store, household: ruled, willys } as unknown as Context, "Carin");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: res.isError === true, text: res.content[0].text };
  };
  const found = JSON.parse((await call("search_products", { query: "soja" })).text) as { code: string; containsGluten?: string; mayContainGluten?: boolean }[];
  assert.deepEqual(found.map((p) => [p.code, p.containsGluten ?? p.mayContainGluten ?? null]), [["SAKURA_ST", null], ["CRISP_ST", null], ["KIKKO_ST", "vete in its ingredients"]]);
  assert.equal((await call("week_add_item", { productCode: "SAKURA_ST", qty: 1, reason: "stir fry", dishId: dish.id })).error, false);
  assert.equal((await call("week_add_item", { productCode: "CRISP_ST", qty: 1, reason: "topping", dishId: dish.id })).error, false);
  const wheat = await call("week_add_item", { productCode: "KIKKO_ST", qty: 1, reason: "Gluten checked: looks fine", dishId: dish.id });
  assert.match(wheat.text, /allows no exception/);
  assert.deepEqual(store.items(NEXT).map((i) => i.productCode), ["SAKURA_ST", "CRISP_ST"]);
  // Each page is fetched once and then read from the store.
  assert.deepEqual(fetched, codes);
});

test("search shows flagged products last, marked", async () => {
  const store = new Store(":memory:");
  const willys = {
    search: async () => ({
      results: [
        { code: "G", name: "Päron Kvarg", manufacturer: "Garant", priceValue: 29.9 },
        { code: "A", name: "Vanilj Kvarg", manufacturer: "Arla", priceValue: 39.9 },
      ],
      pagination: { numberOfPages: 1 },
    }),
  };
  const server = buildServer({ store, household: ruled, willys } as unknown as Context, "Carin");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "search_products", arguments: { query: "kvarg" } })) as { content: { text: string }[] };
  const products = JSON.parse(res.content[0].text) as { code: string; avoid?: string }[];
  assert.deepEqual(products.map((p) => [p.code, p.avoid ?? null]), [["A", null], ["G", "Garant"]]);
});

test("with no Eldorado spices, an Eldorado spice is refused and Eldorado tomatoes are fine", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, NEXT);
  store.recordProduct({ code: "E_SPICE", name: "Grillkrydda Påse", manufacturer: "Eldorado", priceValue: 19.9 }, "regular");
  store.recordProduct({ code: "E_TOM", name: "Krossade Tomater", manufacturer: "Eldorado", priceValue: 9.9 }, "regular");
  const categories: Record<string, string> = { E_SPICE: "Skafferi > Kryddor & smaksättare > Kryddor", E_TOM: "Skafferi > Konserver" };
  const willys = { productInfo: async (code: string) => ({ brand: "Eldorado", category: categories[code], ingredients: null, labels: [] }) };
  const h = { ...household, config: { ...household.config, rules: { avoidBrands: [], avoid: [{ brand: "Eldorado", category: "spices" }], glutenFree: false, staples: [] } } } as unknown as Household;
  const server = buildServer({ store, household: h, willys } as unknown as Context, "Carin");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const add = async (productCode: string) => (await client.callTool({ name: "week_add_item", arguments: { productCode, qty: 1, reason: "x" } })) as { isError?: boolean; content: { text: string }[] };
  assert.match((await add("E_SPICE")).content[0].text, /avoid Eldorado in spices/);
  assert.notEqual((await add("E_TOM")).isError, true);
  assert.deepEqual(store.items(NEXT).map((i) => i.productCode), ["E_TOM"]);
  assert.equal(store.productCategory("E_SPICE"), categories.E_SPICE);
});

test("dish_pick picks and unpicks dishes only for a household that picks", async () => {
  const store = new Store(":memory:");
  const curry = weekWithDish(store, NEXT);
  const chili = store.addDish(NEXT, { name: "Chili", portions: 6 }, "planner");
  const picking = { ...household, config: { ...household.config, plan: { ...household.config.plan, suggestions: 6 } } } as unknown as Household;
  const call = await connect(store, undefined, picking);
  const res = await call("dish_pick", { dishIds: [chili.id] });
  assert.equal(res.error, false, res.text);
  assert.deepEqual(JSON.parse(res.text).dishes.map((d: { name: string; picked: boolean }) => [d.name, d.picked]), [["Curry", false], ["Chili", true]]);
  await call("dish_pick", { dishIds: [chili.id], picked: false });
  assert.equal(store.dish(chili.id)?.pickedBy, null);
  assert.match((await call("dish_pick", { dishIds: [999] })).text, /Dish 999 is not in this week/);
  const everyDish = await connect(store);
  assert.match((await everyDish("dish_pick", { dishIds: [curry.id] })).text, /orders every dish/);
});

test("dish_rate rates dishes from ordered weeks, not suggestions still waiting", async () => {
  const store = new Store(":memory:");
  const waiting = weekWithDish(store, NEXT);
  store.claimWeek(PAST);
  const eaten = store.addDish(PAST, { name: "Chili", portions: 6 }, "planner");
  store.switchWeek(PAST, "drafting", "applied");
  const call = await connect(store);
  assert.equal((await call("dish_rate", { dishId: eaten.id, stars: 4, comment: "a bit dry" })).error, false);
  assert.deepEqual(store.dishRatings(eaten.id).map((r) => [r.member, r.stars, r.comment]), [["Carin", 4, "a bit dry"]]);
  assert.match((await call("dish_rate", { dishId: waiting.id, stars: 5 })).text, /not a dish the household ordered/);
  assert.equal((await call("dish_rate", { dishId: eaten.id, stars: 6 })).error, true);
});

test("dish_add saves a checked recipe, and sends one with problems back with what to fix", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, NEXT);
  const call = await connect(store);
  const recipe = sampleRecipe(6);
  const noRice = { ...recipe, steps: recipe.steps.filter((s) => s.id !== "rice").map((s) => (s.id === "serve" ? { ...s, uses: [], after: ["stew"] } : s)) };
  const bad = await call("dish_add", { name: "Stew", portions: 6, why: "Asked for", recipe: noRice });
  assert.equal(bad.error, true);
  assert.match(bad.text, /Fix the recipe and call dish_add again:\n- Ingredient rice is not used by any step\./);
  assert.equal(store.dishes(NEXT).length, 1);

  const good = await call("dish_add", { name: "Stew", portions: 6, why: "Asked for", recipe });
  assert.equal(good.error, false);
  const dish = store.dishes(NEXT)[1]!;
  assert.deepEqual(store.recipe(dish.recipeId!)?.structured, recipe);
  // A text-only recipe cannot be reused as it is.
  const text = (await call("dish_add", { name: "Curry", portions: 6, why: "Again", recipeId: store.dishes(NEXT)[0]!.recipeId })).text;
  assert.match(text, /has no steps yet/);
});

test("product_info shows what Willys says a product is made of", async () => {
  const info = { code: "LGM", name: "Crispy Chili In Oil", brand: "Laoganma", size: "210g", ingredients: "SOJAolja, chili, lök", labels: [], diet: null, description: null, origin: "Kina" };
  const willys = { productInfo: async (code: string) => ({ ...info, code }) };
  const server = buildServer({ store: new Store(":memory:"), household: ruled, willys } as unknown as Context, "Carin");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "product_info", arguments: { productCode: "LGM" } })) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(res.content[0].text), info);
});

test("a product whose name looks like gluten has its ingredients read, however far down the results it is", async () => {
  const store = new Store(":memory:");
  // Six plain products first, then a chili crisp named like soy sauce.
  const codes = ["A_ST", "B_ST", "C_ST", "D_ST", "E_ST", "F_ST", "CRISP_ST"];
  for (const code of codes) store.recordProduct({ code, name: code === "CRISP_ST" ? "Crispy Chili In Oil Soja" : `Chili ${code}`, priceValue: 25 }, "regular");
  const pages: Record<string, string | null> = { CRISP_ST: "SOJAolja, chili, lök, fermenterade sojabönor [SOJABÖNOR, vatten], salt." };
  const willys = {
    productInfo: async (code: string) => ({ code, name: code, brand: null, size: null, category: "Skafferi", diet: null, description: null, origin: null, ingredients: pages[code] ?? null, labels: [] }),
    search: async () => ({ results: codes.map((code) => ({ code, name: store.productName(code), priceValue: 25 })), pagination: { numberOfPages: 1 } }),
  };
  const server = buildServer({ store, household: ruled, willys } as unknown as Context, "Carin");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "search_products", arguments: { query: "chili" } })) as { content: { text: string }[] };
  const crisp = (JSON.parse(res.content[0].text) as { code: string; mayContainGluten?: string; containsGluten?: string }[]).find((p) => p.code === "CRISP_ST")!;
  assert.equal(crisp.mayContainGluten, undefined, "its ingredients were read, and have no gluten");
  assert.equal(crisp.containsGluten, undefined);
});
