import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { WillysClient } from "../willys/client.ts";
import type { CampaignKind, Product, ProductPage } from "../willys/types.ts";
import { judgePrice, recordSearchResults, snapshotCampaigns } from "./prices.ts";
import { Store } from "./store.ts";

// Prices are recorded and judged by UTC day, so test days are UTC days
// relative to now.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const product = (over: Partial<Product> = {}): Product => ({ code: "KAFFE_ST", name: "Kaffe", displayVolume: "450g", priceValue: 100, ...over });
const promo = (price: number) => product({ potentialPromotions: [{ rewardLabel: `${price},00/st`, qualifyingCount: 1 }] });

function fakeClient(pages: Record<CampaignKind, Product[][]>, numberOfPages?: number) {
  const calls: { kind: CampaignKind; storeId: string; page: number; size: number }[] = [];
  const client = {
    async campaigns(kind: CampaignKind, storeId: string, page: number, size: number): Promise<ProductPage> {
      calls.push({ kind, storeId, page, size });
      const results = pages[kind][page] ?? [];
      const total = numberOfPages ?? pages[kind].length;
      return { results, pagination: { pageSize: size, currentPage: page, numberOfPages: total, totalNumberOfResults: results.length } };
    },
  } as unknown as WillysClient;
  return { client, calls };
}

test("the campaign snapshot reads every page of online and in-store offers", async () => {
  const store = new Store(":memory:");
  const { client, calls } = fakeClient({
    online: [[{ ...promo(59), code: "A_ST", name: "Kaffe A" }, { ...promo(20), code: "B_ST", name: "Kaffe B" }], [{ ...promo(30), code: "C_ST", name: "Kaffe C" }]],
    offline: [[{ ...promo(45), code: "D_ST", name: "Kaffe D" }]],
  });
  const counts = await snapshotCampaigns(client, store, "2299");
  assert.deepEqual(counts, { online: 3, offline: 1 });
  assert.deepEqual(
    calls.map((c) => [c.kind, c.storeId, c.page, c.size]),
    [
      ["online", "2299", 0, 100],
      ["online", "2299", 1, 100],
      ["offline", "2299", 0, 100],
    ],
  );
  assert.deepEqual(store.currentOffers().map((o) => o.code), ["A_ST", "B_ST", "C_ST"]);
  assert.deepEqual(store.currentOffers(undefined, 50, ["offline-promo"]).map((o) => o.code), ["D_ST"]);
});

test("the campaign snapshot stops after 20 pages of each kind", async () => {
  const store = new Store(":memory:");
  const { client, calls } = fakeClient({ online: [], offline: [] }, 500);
  assert.deepEqual(await snapshotCampaigns(client, store, "2299"), { online: 0, offline: 0 });
  assert.equal(calls.filter((c) => c.kind === "online").length, 20);
  assert.equal(calls.filter((c) => c.kind === "offline").length, 20);
});

test("search results record a regular price, and an online offer when there is one", () => {
  const store = new Store(":memory:");
  recordSearchResults(store, [product({ code: "PLAIN_ST" }), { ...promo(80), code: "SALE_ST" }]);
  assert.deepEqual(store.priceHistory("PLAIN_ST").map((h) => [h.kind, h.price]), [["regular", 100]]);
  assert.deepEqual(store.priceHistory("SALE_ST").map((h) => [h.kind, h.price]), [["online-promo", 80], ["regular", 100]]);
});

test("a product never seen before has no verdict", () => {
  const store = new Store(":memory:");
  const v = judgePrice(store, product());
  assert.equal(v.verdict, "unknown");
  assert.deepEqual([v.current, v.currentLabel, v.lowest, v.typical, v.observations], [100, null, null, null, 0]);
  assert.equal(v.summary, "unknown: 100 kr, 0 days of history");
});

test("an offer at the lowest price seen and well under typical is great", () => {
  const store = new Store(":memory:");
  for (const d of [-3, -2, -1]) store.recordProduct(product(), "regular", day(d));
  store.recordProduct(promo(80), "online-promo", day(0));
  const v = judgePrice(store, promo(80));
  assert.equal(v.verdict, "great");
  assert.deepEqual([v.current, v.currentLabel, v.regular, v.lowest, v.typical, v.observations], [80, "80,00/st", 100, 80, 100, 4]);
  assert.equal(v.summary, "great: 80 kr (80,00/st), usually 100, lowest seen 80, 4 days of history");
});

test("an offer at least 10% under typical but above the lowest seen is good", () => {
  const store = new Store(":memory:");
  store.recordProduct(promo(70), "online-promo", day(-4));
  for (const d of [-3, -2, -1]) store.recordProduct(product(), "regular", day(d));
  store.recordProduct(promo(88), "online-promo", day(0));
  const v = judgePrice(store, promo(88));
  assert.equal(v.verdict, "good");
  assert.deepEqual([v.current, v.lowest, v.typical], [88, 70, 100]);
});

test("the usual price is normal, and a price over typical is poor", () => {
  const store = new Store(":memory:");
  for (const d of [-3, -2, -1, 0]) store.recordProduct(product(), "regular", day(d));
  assert.equal(judgePrice(store, product()).verdict, "normal");

  const dearer = new Store(":memory:");
  for (const d of [-3, -2, -1]) dearer.recordProduct(product({ priceValue: 90 }), "regular", day(d));
  dearer.recordProduct(product(), "regular", day(0));
  const v = judgePrice(dearer, product());
  assert.equal(v.verdict, "poor");
  assert.equal(v.summary, "poor: 100 kr, usually 90, lowest seen 90, 4 days of history");
});

test("with little history, today's online offer is judged against the shelf price", () => {
  const store = new Store(":memory:");
  store.recordProduct(promo(80), "online-promo", day(0));
  const v = judgePrice(store, promo(80));
  assert.equal(v.verdict, "good");
  assert.equal(v.summary, "good: 80 kr (80,00/st), usually 80, lowest seen 80, 1 day of history");

  const small = new Store(":memory:");
  small.recordProduct(promo(95), "online-promo", day(0));
  assert.equal(judgePrice(small, promo(95)).verdict, "normal");
});

test("an online offer from an earlier day is not today's price, and in-store offers never are", () => {
  const store = new Store(":memory:");
  store.recordProduct(promo(70), "online-promo", day(-1));
  store.recordProduct(promo(60), "offline-promo", day(0));
  const v = judgePrice(store, product());
  assert.deepEqual([v.current, v.currentLabel, v.lowest], [100, null, 60]);
});
