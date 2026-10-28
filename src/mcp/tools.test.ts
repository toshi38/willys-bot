import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { buildServer } from "./tools.ts";

const household = { id: "test", dir: "/nonexistent", preferences: "", config: { name: "Test", members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }] } } as unknown as Household;

async function connect(store: Store, week?: string) {
  const server = buildServer({ store, household } as unknown as Context, "Carin", { week });
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
  weekWithDish(store, "2026-10-30");
  const call = await connect(store);
  const res = await call("week_add_item", { productCode: "SKYR_ST", qty: 2, reason: "for breakfast" });
  assert.equal(res.error, false);
  const [item] = store.items("2026-10-30");
  assert.deepEqual([item.source, item.requestedBy, item.qty], ["request", "Carin", 2]);
});

test("the tools refuse unknown products, removed dishes and pantry names that do not exist", async () => {
  const store = new Store(":memory:");
  const dish = weekWithDish(store, "2026-10-30");
  const call = await connect(store);
  assert.match((await call("week_add_item", { productCode: "NOPE_ST", qty: 1, reason: "x" })).text, /Unknown product/);
  assert.match((await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x", restocks: "skyr" })).text, /No pantry entry/);
  store.removeDish(dish.id, "Carin");
  assert.match((await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x", dishId: dish.id })).text, /not in this week/);
  assert.equal(store.items("2026-10-30").length, 0);
});

test("pinned to a closed week, the tools change nothing, even with another week open", async () => {
  const store = new Store(":memory:");
  weekWithDish(store, "2026-10-23");
  store.switchWeek("2026-10-23", "open", "applied");
  weekWithDish(store, "2026-10-30");
  const call = await connect(store, "2026-10-23");
  const res = await call("week_add_item", { productCode: "SKYR_ST", qty: 1, reason: "x" });
  assert.match(res.text, /2026-10-23 is applied/);
  assert.equal(store.items("2026-10-30").length, 0);
});
