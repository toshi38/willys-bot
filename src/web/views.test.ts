import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Household } from "../core/household.ts";
import type { Dish, ListItem, PantryItem, Recipe, Week, WeekItem } from "../core/store.ts";
import { esc, homePage, listPage, offersPage, page, pantryPage, productPage, weekDetail, weeksTable, type WeekView } from "./views.ts";

const household = { config: { name: "Lau & co" } } as unknown as Household;

const week = (over: Partial<Week> = {}): Week => ({
  id: "2026-10-30",
  token: "1a2b3c4d",
  status: "open",
  summary: "Two dishes around the chicken offer.",
  notes: "",
  version: 1,
  announcedVersion: 1,
  createdAt: "2026-10-28T06:00:00.000Z",
  sentAt: null,
  decidedBy: null,
  decidedAt: null,
  appliedAt: null,
  error: null,
  ...over,
});

const dish = (over: Partial<Dish> = {}): Dish => ({ id: 1, weekId: "2026-10-30", recipeId: null, name: "Chicken curry", portions: 6, why: "Thigh fillet on offer", origin: null, pickedBy: null, addedBy: "planner", removedAt: null, ...over });

const item = (over: Partial<WeekItem> = {}): WeekItem => ({
  id: 1,
  weekId: "2026-10-30",
  productCode: "SKYR_ST",
  name: "Skyr 400g",
  unitPrice: 18.9,
  qty: 2,
  reason: "",
  source: "staple",
  requestedBy: null,
  listItemId: null,
  dishId: null,
  restocks: null,
  addedBy: "planner",
  removedAt: null,
  ...over,
});

const recipe: Recipe = {
  id: 7,
  name: "Chicken curry",
  servings: 6,
  ingredients: "700 g chicken thigh\n\n1 tin coconut milk",
  method: "1. Brown the chicken.\n2. Simmer.",
  notes: null,
  structured: null,
  createdBy: "planner",
  updatedAt: "2026-10-28T06:00:00.000Z",
};

const view = (over: Partial<WeekView> = {}): WeekView => ({ week: week(), dishes: [], items: [], recipes: new Map(), ...over });

const listItem = (over: Partial<ListItem> = {}): ListItem => ({ id: 3, text: "milk", quantity: null, note: null, productCode: null, addedBy: "Carin", addedAt: "", status: "open", weekId: null, ...over });

const pantryItem = (over: Partial<PantryItem> = {}): PantryItem => ({ id: 1, name: "rice", status: "have", quantity: null, note: null, updatedBy: "Carin", updatedAt: "", ...over });

// The text in one table row, found by a piece of it.
const row = (html: string, has: string) => html.split("<tr>").find((r) => r.includes(has)) ?? "";

test("esc escapes every character that could break out of text or an attribute", () => {
  assert.equal(esc(`<a href="x">Tom & Jerry's</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("the page frame escapes the title, household and member, and marks the current section", () => {
  const html = page({ household, member: "<Carin>", active: "/list", flash: "Saved <b>milk</b>" }, "List & more", "<p>body</p>");
  assert.match(html, /<title>List &amp; more · food-bot<\/title>/);
  assert.match(html, /Lau &amp; co · &lt;Carin&gt;/);
  assert.match(html, /<a href="\/list" class="on">List<\/a>/);
  assert.match(html, /<a href="\/" class="">Home<\/a>/);
  assert.match(html, /<div class="card flash">Saved &lt;b&gt;milk&lt;\/b&gt;<\/div><p>body<\/p>/);
  assert.match(page({ household, member: "Carin", active: "/" }, "Home", ""), /<main><\/main>/);
});

test("each item in a week says what it is for", () => {
  const curry = dish();
  const html = weekDetail(
    view({
      dishes: [curry],
      items: [
        item({ id: 1, productCode: "A", source: "request", requestedBy: "Carin", reason: "breakfast" }),
        item({ id: 2, productCode: "B", source: "request" }),
        item({ id: 3, productCode: "C", source: "dish", dishId: curry.id }),
        item({ id: 4, productCode: "D", source: "dish", dishId: 99 }),
        item({ id: 5, productCode: "E", source: "staple", reason: "restock" }),
      ],
    }),
    false,
  );
  assert.match(row(html, "/product/A"), /<td class="hide-sm muted">asked for by Carin: breakfast<\/td>/);
  assert.match(row(html, "/product/B"), /<td class="hide-sm muted">asked for<\/td>/);
  assert.match(row(html, "/product/C"), /<td class="hide-sm muted">Chicken curry<\/td>/);
  assert.match(row(html, "/product/D"), /<td class="hide-sm muted">dish<\/td>/);
  assert.match(row(html, "/product/E"), /<td class="hide-sm muted">basic or restock: restock<\/td>/);
});

test("a week shows its prices, total, and the product code when the name is unknown", () => {
  const html = weekDetail(view({ items: [item({ qty: 2, unitPrice: 18.9 }), item({ id: 2, productCode: "X/1", name: null, unitPrice: null, qty: 1 })] }), false);
  assert.match(html, /<h2>Shopping, about 37,80 kr<\/h2>/);
  assert.match(row(html, "Skyr 400g"), /<td class="num">18,90 kr<\/td>/);
  assert.match(row(html, "X%2F1"), /<a href="\/product\/X%2F1">X\/1<\/a><\/td><td class="num"><\/td>/);
});

test("a dish shows its recipe when it has one, and every value is escaped", () => {
  const html = weekDetail(
    view({
      dishes: [dish({ recipeId: 7 }), dish({ id: 2, name: "<script>Chili</script>", portions: 4, why: "Beans & mince" })],
      recipes: new Map([[7, recipe]]),
    }),
    false,
  );
  assert.match(html, /<strong>Chicken curry<\/strong> <span class="muted">6 portions<\/span><br>Thigh fillet on offer<details><summary>Recipe<\/summary><ul><li>700 g chicken thigh<\/li><li>1 tin coconut milk<\/li><\/ul><p style="white-space:pre-line">1. Brown the chicken.\n2. Simmer.<\/p><\/details>/);
  assert.match(html, /<strong>&lt;script&gt;Chili&lt;\/script&gt;<\/strong> <span class="muted">4 portions<\/span><br>Beans &amp; mince<\/div>/);
  assert.equal(html.match(/<details>/g)?.length, 1);
});

test("only an open week offers a decision, and not while it is being worked on", () => {
  const open = weekDetail(view(), false);
  assert.match(open, /action="\/plans\/2026-10-30\/approve"/);
  assert.match(open, /action="\/plans\/2026-10-30\/reject"/);
  assert.match(open, /action="\/plans\/2026-10-30\/change"/);

  const busy = weekDetail(view(), true);
  assert.match(busy, /Working on it: refresh in a minute/);
  assert.doesNotMatch(busy, /\/approve/);

  for (const status of ["drafting", "approved", "applied", "skipped", "failed"] as const) {
    const html = weekDetail(view({ week: week({ status }) }), false);
    assert.doesNotMatch(html, /Your decision|\/approve|Working on it/, status);
    assert.match(html, new RegExp(`<span class="badge s-${status}">${status}</span>`), status);
  }
});

test("a decided week shows who decided, when the cart was filled, any error and its notes", () => {
  const html = weekDetail(
    view({ week: week({ status: "failed", decidedBy: "Carin", decidedAt: "2026-10-28T08:00:00.000Z", appliedAt: "2026-10-28T08:01:00.000Z", error: "Slot <gone>", notes: "Check the eggs" }) }),
    false,
  );
  assert.match(html, /\. Decided by Carin /);
  assert.match(html, /\. Cart filled /);
  assert.match(html, /<strong>Error:<\/strong> Slot &lt;gone&gt;/);
  assert.match(html, /<h2>Notes<\/h2><div class="card" style="white-space:pre-line">Check the eggs<\/div>/);

  const plain = weekDetail(view(), false);
  assert.doesNotMatch(plain, /Decided by|Cart filled|Error:|<h2>Notes/);
});

test("the weeks table lists each week with its dishes and estimate", () => {
  assert.equal(weeksTable([]), `<p class="muted">No weeks yet.</p>`);
  const html = weeksTable([
    view({ dishes: [dish(), dish({ id: 2, name: "Chili & rice" })], items: [item({ qty: 3, unitPrice: 10 })] }),
    view({ week: week({ id: "2026-10-23", status: "applied" }) }),
  ]);
  assert.match(row(html, "2026-10-30"), /<a href="\/plans\/2026-10-30">2026-10-30<\/a>.*s-open.*<td>Chicken curry<br>Chili &amp; rice<\/td><td class="num hide-sm">30 kr<\/td>/s);
  assert.match(row(html, "2026-10-23"), /s-applied.*<td><\/td><td class="num hide-sm">0 kr<\/td>/s);
});

test("the home page shows the latest week, the list, what is running low and earlier menus", () => {
  const html = homePage(
    view({ dishes: [dish()] }),
    [view({ week: week({ id: "2026-10-23", status: "applied" }) })],
    [listItem({ quantity: "2" }), listItem({ id: 4, text: "<eggs>", addedBy: "Stephen" })],
    [pantryItem(), pantryItem({ id: 2, name: "salt", status: "low" }), pantryItem({ id: 3, name: "oil", status: "out" })],
  );
  assert.match(html, /<strong>Pickup 2026-10-30<\/strong>/);
  assert.match(html, /<ul><li>Chicken curry<\/li><\/ul><a href="\/plans\/2026-10-30">Open the plan<\/a>/);
  assert.match(html, /<h2>On the list \(2\)<\/h2>/);
  assert.match(html, /<li>milk × 2 <span class="muted">Carin<\/span><\/li><li>&lt;eggs&gt; <span class="muted">Stephen<\/span><\/li>/);
  assert.match(html, /<h2>Running low \(2\)<\/h2>/);
  assert.match(html, /<li>salt <span class="badge s-low">low<\/span><\/li><li>oil <span class="badge s-out">out<\/span><\/li>/);
  assert.doesNotMatch(html, /<li>rice /);
  assert.match(html, /href="\/plans\/2026-10-23"/);
});

test("an empty home page says there is nothing yet", () => {
  const html = homePage(null, [], [], [pantryItem()]);
  assert.match(html, /No plan yet\./);
  assert.match(html, /<h2>On the list \(0\)<\/h2>\n<p class="muted">Nothing yet\.<\/p>/);
  assert.match(html, /<h2>Running low \(0\)<\/h2>\n<p class="muted">Nothing marked low or out\.<\/p>/);
  assert.match(html, /No weeks yet\./);
});

test("the list page shows each item's details and a way to remove it", () => {
  assert.match(listPage([], () => null), /The list is empty\./);
  const names: Record<string, string> = { MILK_ST: "Mellanmjölk 1,5l" };
  const html = listPage(
    [listItem({ quantity: "2", note: "lactose free", productCode: "MILK_ST" }), listItem({ id: 4, text: "eggs", productCode: "EGGS_ST", addedBy: "<Stephen>" })],
    (code) => names[code] ?? null,
  );
  assert.match(row(html, "milk"), /<td>milk × 2 <span class="muted">\(lactose free\)<\/span><br><span class="muted">Mellanmjölk 1,5l<\/span><\/td><td class="hide-sm muted">Carin<\/td>/);
  assert.match(row(html, "milk"), /action="\/list\/3\/remove"/);
  assert.match(row(html, "eggs"), /<td>eggs<br><span class="muted">EGGS_ST<\/span><\/td><td class="hide-sm muted">&lt;Stephen&gt;<\/td>/);
});

test("the pantry page selects each entry's status and escapes names in its forms", () => {
  assert.match(pantryPage([]), /Nothing recorded yet\./);
  const html = pantryPage([pantryItem({ name: `Mrs "Chang" soy`, status: "low", quantity: "1 bottle", note: "the dark one" })]);
  const entry = row(html, "Mrs &quot;Chang");
  assert.match(entry, /<td>Mrs &quot;Chang&quot; soy <span class="muted">1 bottle<\/span><br><span class="muted">the dark one<\/span><\/td>/);
  assert.match(entry, /<input type="hidden" name="name" value="Mrs &quot;Chang&quot; soy">/);
  assert.match(entry, /<option>have<\/option><option selected>low<\/option><option>out<\/option>/);
  assert.match(entry, /action="\/pantry\/remove"/);
  // The form for a new entry starts at "have".
  assert.match(html.split("<table>")[0], /<option selected>have<\/option>/);
});

test("the offers page lists offers and says when there are none", () => {
  const html = offersPage(`"kaffe"`, [{ code: "K_ST", name: "Kaffe", volume: "450g", price: 49.9, regular: 67.9, label: "Spara 18 kr" }]);
  assert.match(html, /value="&quot;kaffe&quot;"/);
  assert.match(html, /<td class="num">49,90 kr<\/td><td class="num hide-sm muted">67,90 kr<\/td><td class="hide-sm muted">Spara 18 kr<\/td>/);
  assert.doesNotMatch(html, /No offers recorded/);
  assert.match(offersPage("", []), /No offers recorded/);
});

test("the product page draws a chart once there are two days of prices", () => {
  const one = productPage("K_ST", null, [{ productCode: "K_ST", observedOn: "2026-10-28", kind: "regular", price: 67.9, comparePrice: null, label: null }]);
  assert.match(one, /<h1>K_ST<\/h1>/);
  assert.match(one, /The chart appears once there are two days of prices/);

  const two = productPage("K_ST", "Kaffe", [
    { productCode: "K_ST", observedOn: "2026-10-28", kind: "regular", price: 67.9, comparePrice: null, label: null },
    { productCode: "K_ST", observedOn: "2026-10-29", kind: "online-promo", price: 49.9, comparePrice: null, label: "Spara 18 kr" },
  ]);
  assert.match(two, /<svg /);
  assert.equal(two.match(/<polyline /g)?.length, 2);
  assert.match(two, /49,90 kr to 67,90 kr, 2026-10-28 to 2026-10-29/);
  // Newest observation first in the table.
  assert.ok(two.indexOf("<td>2026-10-29</td>") < two.indexOf("<td>2026-10-28</td>"));
});
