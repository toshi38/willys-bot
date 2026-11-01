import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { buildServer } from "./tools.ts";

// Weeks relative to today, so the tests do not expire.
const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));
const NEXT = day(3);
const PAST = day(-4);

const household = { id: "test", dir: "/nonexistent", preferences: "", config: { name: "Test", members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }] } } as unknown as Household;

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

test("an avoided brand or a gluten risk is refused unless the exception is stated", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, NEXT);
  store.recordProduct({ code: "GARANT_ST", name: "Päron Kvarg 900g", manufacturer: "Garant", priceValue: 29.9 }, "regular");
  store.recordProduct({ code: "SOY_ST", name: "Japansk Soja 150ml", priceValue: 24.9 }, "regular");
  const call = await connect(store, undefined, ruled);
  assert.match((await call("week_add_item", { productCode: "GARANT_ST", qty: 1, reason: "kvarg" })).text, /breaks the household rule "avoid Garant"/);
  assert.match((await call("week_add_item", { productCode: "SOY_ST", qty: 1, reason: "stir fry" })).text, /contains gluten/);
  assert.equal(store.items(NEXT).length, 0);
  assert.equal((await call("week_add_item", { productCode: "GARANT_ST", qty: 1, reason: "Brand exception: Arla is sold out" })).error, false);
  assert.equal(store.items(NEXT).length, 1);
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
  const willys = { productDetails: async (code: string) => ({ brand: "Eldorado", category: categories[code] }) };
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
