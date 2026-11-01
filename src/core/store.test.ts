import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataDir, promoUnitPrice, Store } from "./store.ts";
import type { Product } from "../willys/types.ts";

const product = (over: Partial<Product>): Product => ({ code: "1_ST", name: "Kaffe", displayVolume: "450g", priceValue: 67.9, ...over });

test("promotion unit prices are read from the labels", () => {
  assert.equal(promoUnitPrice(7.9, { conditionLabel: "3 för", rewardLabel: "10,00", qualifyingCount: 3 }), 3.33);
  assert.equal(promoUnitPrice(24.9, { conditionLabel: "Spara 15,00 kr/st", rewardLabel: "9,90/st", qualifyingCount: 1 }), 9.9);
  assert.equal(promoUnitPrice(169, { rewardLabel: "139/kg", qualifyingCount: 1 }), 139);
  assert.equal(promoUnitPrice(30, { price: 19.9 }), 19.9);
  assert.equal(promoUnitPrice(30, { rewardLabel: "20%" }), 20);
});

test("in-store offers do not set the online price", () => {
  const store = new Store(":memory:");
  store.recordProduct(product({ potentialPromotions: [{ rewardLabel: "49,90/st", qualifyingCount: 1 }] }), "offline-promo");
  assert.equal(store.latestPrice("1_ST"), 67.9);
  assert.deepEqual(store.currentOffers(), []);
  store.recordProduct(product({ potentialPromotions: [{ rewardLabel: "59,90/st", qualifyingCount: 1 }] }), "online-promo");
  assert.equal(store.latestPrice("1_ST"), 59.9);
  assert.equal(store.currentOffers()[0].price, 59.9);
});

test("product names are not repeated with their size", () => {
  const store = new Store(":memory:");
  store.recordProduct(product({ name: "Champinjoner 250g", displayVolume: "250g" }), "regular");
  assert.equal(store.productName("1_ST"), "Champinjoner 250g");
});

test("list items move from open to ordered", () => {
  const store = new Store(":memory:");
  const item = store.addListItem({ text: "diskmedel", addedBy: "Carin" });
  assert.equal(store.listItems().length, 1);
  store.updateListItem(item.id, { status: "ordered", weekId: "2026-10-30" });
  assert.equal(store.listItems().length, 0);
});

test("pantry entries match by name regardless of case and keep their details", () => {
  const store = new Store(":memory:");
  store.setPantryItem({ name: "Jasmine rice", status: "have", quantity: "2 kg", updatedBy: "Carin" });
  const updated = store.setPantryItem({ name: " jasmine RICE ", status: "low", updatedBy: "Stephen" });
  assert.equal(store.pantryItems().length, 1);
  assert.equal(updated.status, "low");
  assert.equal(updated.quantity, "2 kg");
  assert.equal(store.removePantryItem("Jasmine Rice"), true);
  assert.deepEqual(store.pantryItems(), []);
});

// UTC days relative to now, the days prices are recorded under.
const utcDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const changeLog = (store: Store) => store.claimChanges().map((c) => `${c.by} ${c.text}`);

test("changing a list item's details is logged with its new details", () => {
  const store = new Store(":memory:");
  const milk = store.addListItem({ text: "milk", quantity: "1", addedBy: "Carin" });
  store.claimChanges();
  store.updateListItem(milk.id, { quantity: "3" }, "Stephen");
  store.updateListItem(milk.id, { note: "lactose free" }, "Carin");
  store.updateListItem(milk.id, { productCode: "MILK_ST" }, "Carin");
  assert.deepEqual(changeLog(store), [
    "Stephen changed 3 x milk on the list",
    "Carin changed 3 x milk (lactose free) on the list",
    "Carin changed 3 x milk (lactose free) on the list",
  ]);
});

test("a list update that changes nothing, or is made by the bot, is not logged", () => {
  const store = new Store(":memory:");
  const milk = store.addListItem({ text: "milk", quantity: "1", addedBy: "Carin" });
  store.claimChanges();
  store.updateListItem(milk.id, { quantity: "1" }, "Stephen");
  store.updateListItem(milk.id, { status: "planned", weekId: "2026-10-30" }, "Stephen");
  store.updateListItem(milk.id, { quantity: "2" });
  assert.deepEqual(changeLog(store), []);
});

test("removing a list item is logged once, with the details it had", () => {
  const store = new Store(":memory:");
  const milk = store.addListItem({ text: "milk", quantity: "2", note: "big", addedBy: "Carin" });
  store.claimChanges();
  const removed = store.updateListItem(milk.id, { status: "removed", quantity: null }, "Stephen");
  store.updateListItem(milk.id, { status: "removed" }, "Stephen");
  assert.equal(removed?.status, "removed");
  assert.deepEqual(changeLog(store), ["Stephen removed 2 x milk (big) from the list"]);
  assert.deepEqual(store.listItems(["removed"]).map((i) => i.id), [milk.id]);
});

test("updating a list item that does not exist does nothing", () => {
  const store = new Store(":memory:");
  assert.equal(store.updateListItem(42, { status: "removed" }, "Carin"), null);
  assert.deepEqual(changeLog(store), []);
});

test("pantry changes are logged when the status changes, and removals when something was removed", () => {
  const store = new Store(":memory:");
  store.setPantryItem({ name: "rice", status: "have", updatedBy: "Carin" });
  store.setPantryItem({ name: "rice", status: "have", quantity: "1 kg", updatedBy: "Carin" });
  store.setPantryItem({ name: "rice", status: "out", updatedBy: "Stephen" });
  assert.equal(store.removePantryItem("  RICE ", "Carin"), true);
  assert.equal(store.removePantryItem("rice", "Carin"), false);
  store.setPantryItem({ name: "salt", status: "have", updatedBy: "Carin" });
  assert.equal(store.removePantryItem("salt"), true);
  assert.deepEqual(changeLog(store), [
    "Carin marked rice as in stock in the pantry",
    "Stephen marked rice as out in the pantry",
    "Carin stopped tracking RICE in the pantry",
    "Carin marked salt as in stock in the pantry",
  ]);
});

test("released changes are claimed again on the next run", () => {
  const store = new Store(":memory:");
  store.logChange("Carin", "did a thing");
  store.logChange("Carin", "did another");
  const claimed = store.claimChanges();
  assert.deepEqual(store.claimChanges(), []);
  store.releaseChanges([claimed[1].id]);
  assert.deepEqual(store.claimChanges().map((c) => c.text), ["did another"]);
});

test("price history covers the days asked for, oldest first", () => {
  const store = new Store(":memory:");
  for (const d of [-400, -40, -10, 0]) store.recordProduct(product({}), "regular", utcDay(d));
  store.recordProduct(product({ code: "OTHER_ST" }), "regular", utcDay(0));
  assert.deepEqual(store.priceHistory("1_ST").map((h) => h.observedOn), [utcDay(-40), utcDay(-10), utcDay(0)]);
  assert.deepEqual(store.priceHistory("1_ST", 30).map((h) => h.observedOn), [utcDay(-10), utcDay(0)]);
  assert.deepEqual(store.priceHistory("NONE_ST"), []);
  assert.deepEqual(store.priceHistory("1_ST", 0), [{ productCode: "1_ST", observedOn: utcDay(0), kind: "regular", price: 67.9, comparePrice: null, label: null }]);
});

test("current offers come from the latest snapshot day, filtered by name or brand", () => {
  const store = new Store(":memory:");
  const offer = (code: string, name: string, manufacturer: string, reward: string) =>
    product({ code, name, manufacturer, displayVolume: "500g", potentialPromotions: [{ conditionLabel: "Max 2", rewardLabel: reward, qualifyingCount: 1 }] });
  store.recordProduct(offer("OLD_ST", "Kycklingfilé", "Kronfågel", "50,00/st"), "online-promo", utcDay(-1));
  store.recordProduct(offer("A_ST", "Kycklinglår", "Kronfågel", "49,90/st"), "online-promo");
  store.recordProduct(offer("B_ST", "Bryggkaffe", "Garant", "39,90/st"), "online-promo");
  store.recordProduct(offer("C_ST", "Ost", "Arla", "59,90/st"), "offline-promo");
  assert.deepEqual(store.currentOffers().map((o) => o.code), ["B_ST", "A_ST"]);
  assert.deepEqual(store.currentOffers("KYCKLING").map((o) => o.code), ["A_ST"]);
  assert.deepEqual(store.currentOffers("garant").map((o) => o.code), ["B_ST"]);
  assert.deepEqual(store.currentOffers(undefined, 1).map((o) => o.code), ["B_ST"]);
  assert.deepEqual(store.currentOffers(undefined, 50, ["offline-promo"]).map((o) => o.code), ["C_ST"]);
  assert.deepEqual(store.currentOffers("kyckling")[0], { code: "A_ST", name: "Kycklinglår", volume: "500g", kind: "online-promo", price: 49.9, regular: 67.9, label: "Max 2 49,90/st" });
});

test("weeks are found by token and listed newest first", () => {
  const store = new Store(":memory:");
  for (const id of ["2026-10-16", "2026-10-30", "2026-10-23"]) store.claimWeek(id);
  const w = store.week("2026-10-23")!;
  assert.match(w.token, /^[0-9a-f]{8}$/);
  assert.equal(store.weekByToken(w.token)?.id, "2026-10-23");
  assert.equal(store.weekByToken("00000000"), null);
  assert.deepEqual(store.weeks().map((x) => x.id), ["2026-10-30", "2026-10-23", "2026-10-16"]);
  assert.deepEqual(store.weeks(2).map((x) => x.id), ["2026-10-30", "2026-10-23"]);
});

test("dropping a week takes its dishes and items with it, and leaves other weeks alone", () => {
  const store = new Store(":memory:");
  store.recordProduct(product({}), "regular");
  for (const id of ["2026-10-23", "2026-10-30"]) {
    store.claimWeek(id);
    const d = store.addDish(id, { name: "Curry", portions: 4 }, "planner");
    store.addItem(id, { productCode: "1_ST", qty: 1, source: "dish", dishId: d.id }, "planner");
  }
  store.dropWeek("2026-10-30");
  assert.equal(store.week("2026-10-30"), null);
  assert.deepEqual(store.allItems("2026-10-30"), []);
  assert.deepEqual(store.dishes("2026-10-30"), []);
  assert.equal(store.dishes("2026-10-23").length, 1);
  assert.equal(store.items("2026-10-23").length, 1);
  assert.equal(store.claimWeek("2026-10-30"), true);
});

test("past dishes are those of earlier weeks, newest week first, without removed dishes", () => {
  const store = new Store(":memory:");
  const recipe = store.saveRecipe({ name: "Curry", ingredients: "", method: "" }, "planner");
  for (const id of ["2026-10-16", "2026-10-23", "2026-10-30"]) store.claimWeek(id);
  store.updateWeek("2026-10-16", { status: "applied" });
  store.addDish("2026-10-16", { name: "Soup", portions: 4 }, "planner");
  store.addDish("2026-10-23", { name: "Curry", portions: 4, recipeId: recipe.id }, "planner");
  const gone = store.addDish("2026-10-23", { name: "Tacos", portions: 4 }, "planner");
  store.addDish("2026-10-23", { name: "Chili", portions: 4 }, "planner");
  store.addDish("2026-10-30", { name: "This week", portions: 4 }, "planner");
  store.removeDish(gone.id, "Carin");
  assert.deepEqual(store.pastDishes("2026-10-30"), [
    { weekId: "2026-10-23", name: "Curry", recipeId: recipe.id, status: "drafting" },
    { weekId: "2026-10-23", name: "Chili", recipeId: null, status: "drafting" },
    { weekId: "2026-10-16", name: "Soup", recipeId: null, status: "applied" },
  ]);
  assert.deepEqual(store.pastDishes("2026-10-30", 1).map((d) => d.name), ["Curry"]);
  assert.deepEqual(store.pastDishes("2026-10-16"), []);
});

test("recipes are filtered by a part of their name", () => {
  const store = new Store(":memory:");
  store.saveRecipe({ name: " Chicken curry ", ingredients: "chicken", method: "cook" }, "planner");
  store.saveRecipe({ name: "Chili con carne", ingredients: "mince", method: "cook" }, "Carin");
  assert.deepEqual(store.recipes("curry").map((r) => r.name), ["Chicken curry"]);
  assert.deepEqual(store.recipes("Ch").map((r) => r.name).sort(), ["Chicken curry", "Chili con carne"]);
  assert.deepEqual(store.recipes("lasagne"), []);
  assert.equal(store.recipes().length, 2);
});

test("a received email's record is kept, and later updates change only its outcome", () => {
  const store = new Store(":memory:");
  assert.equal(store.mailRecord("re_1"), null);
  store.recordMail({ id: "re_1", receivedAt: "2026-10-28T08:00:00Z", sender: "carin@lau.engineering", subject: "milk", status: "retry", attempts: 1, note: "Claude timed out" });
  store.recordMail({ id: "re_1", receivedAt: "2026-10-29T00:00:00Z", sender: "x@y.z", subject: "other", status: "handled", attempts: 2, note: null });
  const { updatedAt, ...rest } = store.mailRecord("re_1")!;
  assert.deepEqual(rest, { id: "re_1", receivedAt: "2026-10-28T08:00:00Z", sender: "carin@lau.engineering", subject: "milk", status: "handled", attempts: 2, note: null });
  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a failed transaction leaves nothing behind", () => {
  const store = new Store(":memory:");
  assert.throws(
    () =>
      store.transaction(() => {
        store.addListItem({ text: "milk", addedBy: "Carin" });
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.deepEqual(store.listItems(), []);
  assert.equal(store.transaction(() => 7), 7);
});

test("small state can be claimed once, set, read and deleted", () => {
  const store = new Store(":memory:");
  assert.equal(store.claim("k", "a"), true);
  assert.equal(store.claim("k", "b"), false);
  assert.equal(store.get("k"), "a");
  store.set("k", "c");
  assert.equal(store.get("k"), "c");
  store.delete("k");
  assert.equal(store.get("k"), null);
});

test("each household's data directory is made under WILLYS_BOT_DATA", () => {
  const base = mkdtempSync(join(tmpdir(), "data-"));
  process.env.WILLYS_BOT_DATA = `${base}/`;
  const dir = dataDir("lau");
  delete process.env.WILLYS_BOT_DATA;
  assert.equal(dir, `${base}/lau`);
  assert.equal(existsSync(dir), true);
  const store = new Store(join(dir, "willys-bot.sqlite"));
  assert.equal(store.dir, dir);
  store.close();
  assert.equal(existsSync(join(dir, "willys-bot.sqlite")), true);
});
