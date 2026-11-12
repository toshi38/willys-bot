import { readFileSync } from "node:fs";
import { openContext } from "../src/core/context.ts";
import { localDate, nextPickup } from "../src/plan/week.ts";
import { runIntake } from "../src/plan/inbox.ts";
import { DISHES, ITEMS, SCENARIOS, type Snapshot } from "./scenarios.ts";

// One run of one scenario, in its own process and data directory (set up by
// run.ts): seeds the week, sends the message through the real intake with
// the real Claude, and prints what the checks found as one JSON line.

const name = process.argv[2];
const scenario = SCENARIOS.find((s) => s.name === name);
if (!scenario) throw new Error(`No scenario ${name}`);

const ctx = openContext("eval");
const { store } = ctx;
for (const p of JSON.parse(readFileSync(process.env.EVAL_CATALOG!, "utf8")) as { code: string; name: string; price: number; brand?: string }[]) {
  store.recordProduct({ code: p.code, name: p.name, manufacturer: p.brand, priceValue: p.price, displayVolume: "" }, "regular");
}
store.setPantryItem({ name: "rice", status: "have", updatedBy: "Carin" });
store.setPantryItem({ name: "coconut milk", status: "have", updatedBy: "Carin" });

const weekId = scenario.week === "past" ? localDate(new Date(Date.now() - 6 * 86_400_000)) : localDate(nextPickup(ctx.household));
if (scenario.week === "past") {
  // Last week's shop, ordered and picked up.
  store.claimWeek(weekId);
  const r = store.saveRecipe(
    { name: "Coconut chicken and butternut curry", servings: 6, ingredients: ["1.4 kg chicken thigh fillet", "1 kg butternut squash", "2 tins coconut milk", "2 limes", "ginger, garlic, chili"].join("\n"), method: "1. Brown the chicken. 2. Add the butternut and coconut milk. 3. Simmer 30 minutes, finish with lime." },
    "planner",
  );
  const dish = store.addDish(weekId, { name: "Coconut chicken and butternut curry", portions: 6, why: "Thigh fillet on offer", recipeId: r.id }, "planner");
  store.addItem(weekId, { productCode: "CHICKEN_THIGH_ST", qty: 2, reason: "For the curry", source: "dish", dishId: dish.id }, "planner");
  store.updateWeek(weekId, { summary: "Last week.", notes: "" });
  store.switchWeek(weekId, "drafting", "applied");
} else if (scenario.week !== "none") {
  store.claimWeek(weekId);
  const dishIds = Object.fromEntries(
    DISHES.map((d) => {
      const r = store.saveRecipe({ name: d.name, servings: 6, ingredients: "see the shop", method: "1. Cook it slowly. 2. Season and serve." }, "planner");
      return [d.key, store.addDish(weekId, { name: d.name, portions: 6, why: "On offer", recipeId: r.id }, "planner").id];
    }),
  );
  for (const i of ITEMS) store.addItem(weekId, { productCode: i.code, qty: i.qty, reason: i.reason, source: i.source, requestedBy: i.by ?? null, dishId: i.dish ? dishIds[i.dish] : null }, "planner");
  store.updateWeek(weekId, { summary: "Three strong, high protein dishes built around this week's offers.", notes: "" });
  store.switchWeek(weekId, "drafting", scenario.week === "open" ? "open" : "applied");
}

const snapshot = (): Snapshot => ({
  items: store.items(weekId),
  dishes: store.dishes(weekId),
  pantry: store.pantryItems(),
  list: store.listItems(["open", "planned"]).map((i) => ({ text: i.text, status: i.status })),
  preferences: ctx.household.preferences,
});

const before = snapshot();
const week = scenario.week === "past" ? store.currentWeek(localDate(new Date())) : store.week(weekId);
const order =
  scenario.week === "approved"
    ? { placed: false, closeTime: "Thursday 23:59", order: null }
    : scenario.week === "placed"
      ? { placed: true, closeTime: null, order: { number: "1000000001", total: 900, editable: true, editing: false, closes: "Thursday 23:59" } }
      : scenario.week === "closed"
        ? { placed: true, closeTime: null, order: { number: "1000000001", total: 900, editable: false, editing: false, closes: null } }
        : null;
const started = Date.now();
let reply = "";
let redraft = "";
let error: string | null = null;
try {
  const out = await runIntake(ctx, { name: scenario.from, via: "slack", subject: "", text: scenario.text, week, order, thread: scenario.thread ?? [] });
  reply = out.reply;
  redraft = out.redraft;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}
const after = snapshot();
const failures = error ? [`the run failed: ${error}`] : scenario.check({ before, after, reply, redraft }, store);
console.log(JSON.stringify({ name, pass: failures.length === 0, failures, reply, redraft, ms: Date.now() - started }));
ctx.close();
