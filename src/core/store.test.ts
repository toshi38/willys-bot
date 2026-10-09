import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promoUnitPrice, Store } from "./store.ts";
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
  store.updateListItem(item.id, { status: "ordered", planId: "p1" });
  assert.equal(store.listItems().length, 0);
});
