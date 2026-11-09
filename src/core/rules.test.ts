import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Context } from "./context.ts";
import type { Household } from "./household.ts";
import { brokenRule, glutenInIngredients, glutenVerdict, needsCategory, productFacts, ruleProblems } from "./rules.ts";
import { Store } from "./store.ts";

const household = (avoid: object[] = [], avoidBrands: string[] = []) =>
  ({ config: { rules: { avoidBrands, avoid, glutenFree: true, staples: [] } } }) as unknown as Household;

const SPICES = "Skafferi > Kryddor & smaksättare > Kryddor";
const grill = { code: "E1_ST", name: "Grillkrydda Påse", brand: "Eldorado", category: SPICES };
const tomatoes = { code: "E2_ST", name: "Krossade Tomater", brand: "Eldorado", category: "Skafferi > Konserver" };

test("a whole brand is avoided by brand or by name, in any case; avoidBrands is shorthand for it", () => {
  const h = household([], ["Garant"]);
  assert.ok(brokenRule(h, { code: "G", name: "Päron Kvarg 900g", brand: "GARANT" }));
  assert.ok(brokenRule(h, { code: "G", name: "Garant Krossade tomater" }));
  assert.equal(brokenRule(h, { code: "A", name: "Vanilj Mild Kvarg", brand: "Arla" }), null);
});

test("a brand can be avoided in one category only, named in Swedish or in English", () => {
  for (const category of ["spices", "Kryddor"]) {
    const h = household([{ brand: "Eldorado", category }]);
    assert.ok(brokenRule(h, grill), category);
    assert.equal(brokenRule(h, tomatoes), null, category);
  }
});

test("a rule on a category waits for the category, and needs it only when the rest matches", () => {
  const h = household([{ brand: "Eldorado", category: "spices" }]);
  const unknown = { ...grill, category: undefined };
  assert.equal(needsCategory(h, unknown), true);
  assert.equal(brokenRule(h, unknown), null);
  assert.equal(needsCategory(h, { code: "A", name: "Kanel Malen", brand: "Santa Maria" }), false);
});

test("a rule can name words in the product, one product code, or both a brand and words", () => {
  const h = household([{ brand: "Garant", name: "crème fraiche" }, { product: "X_ST" }]);
  assert.ok(brokenRule(h, { code: "G1", name: "Crème Fraiche 34%", brand: "Garant" }));
  assert.equal(brokenRule(h, { code: "G2", name: "Crème Fraiche 34%", brand: "Arla" }), null);
  assert.equal(brokenRule(h, { code: "G3", name: "Gräddfil", brand: "Garant" }), null);
  assert.ok(brokenRule(h, { code: "X_ST", name: "Anything" }));
});

test("a stated exception passes a rule, except a strict one, which wins over a lenient rule", () => {
  const h = household([{ brand: "Garant" }, { brand: "Garant", name: "crème fraiche", strict: true, note: "Carin dislikes it" }]);
  const kvarg = { code: "G1", name: "Päron Kvarg", brand: "Garant" };
  const cf = { code: "G2", name: "Crème Fraiche 34%", brand: "Garant" };
  assert.match(ruleProblems(h, kvarg, "cheap").join(" "), /avoid Garant/);
  assert.deepEqual(ruleProblems(h, kvarg, "Brand exception: every other kvarg costs more than double"), []);
  const strict = ruleProblems(h, cf, "Brand exception: only one in stock").join(" ");
  assert.match(strict, /allows no exception/);
  assert.match(strict, /Carin dislikes it/);
});

test("without ingredients, gluten words in the name are flagged unless labelled gluten free, and only for gluten-free households", () => {
  const h = household();
  const name = (n: string) => glutenVerdict(h, { name: n });
  for (const n of ["Vetemjöl 2kg", "Spaghetti 500g", "Rågbröd", "Japansk Soja 150ml", "Äggnudlar 250g", "Couscous"]) assert.equal(name(n)?.kind, "looks like", n);
  for (const n of ["Glutenfri Pasta Penne", "Mellanmjölk Laktosfri 1,5l", "Kokosmjölk 400ml", "Risnudlar 250g", "Majskorn 3-pack", "Potatismjöl"]) assert.equal(name(n), null, n);
  const any = { config: { rules: { avoidBrands: [], avoid: [], glutenFree: false, staples: [] } } } as unknown as Household;
  assert.equal(glutenVerdict(any, { name: "Spaghetti", ingredients: "VETE" }), null);
  assert.match(ruleProblems(h, { code: "S", name: "Japansk Soja" }, "stir fry").join(" "), /looks like it contains gluten \("soja"\)/);
  assert.deepEqual(ruleProblems(h, { code: "S", name: "Japansk Soja" }, "Gluten checked: labelled tamari"), []);
});

test("gluten sources and declared traces are found in Willys ingredient lists", () => {
  const found = (i: string) => glutenInIngredients(i);
  assert.deepEqual(found("Vatten, SOJABÖNOR 26%, salt, VETE 12% (GLUTEN), E621."), { word: "vete", trace: false });
  assert.deepEqual(found("HAVREflingor*, cornflakes (majsmjöl, maltextrakt (KORN))."), { word: "korn", trace: false });
  assert.deepEqual(found("Mandel, socker. Kan innehålla spår av VETE och JORDNÖTTER."), { word: "vete", trace: true });
  assert.equal(found("HAVREgryn 100%.")?.word, "havre");
  for (const clean of [
    "SOJAolja [45%], chili [25%], lök [15%], fermenterade sojabönor [SOJABÖNOR, vatten], smakförstärkare: [E621], salt, socker, Sichuan pepparpulver.",
    "Bovetemjöl, majskorn, svartpepparkorn, maltodextrin, salt.",
    "Glutenfri havre 100%.",
    "Mjölk, EMMENTALER ost, salt. Kan innehålla spår av HASSELNÖTTER och MANDEL.",
  ]) assert.equal(found(clean), null, clean);
});

test("ingredients decide over the name, a gluten-free label over both, and listed gluten allows no exception", () => {
  const h = household();
  // A soy sauce brewed with corn: the name looks risky, the ingredients are clean.
  assert.equal(glutenVerdict(h, { name: "Japansk Soja", ingredients: "Vatten, SOJABÖNOR, majsmjöl, salt." }), null);
  assert.equal(glutenVerdict(h, { name: "Japansk Soja", ingredients: null, labels: ["Sånär Fri Från Gluten"] }), null);
  assert.equal(glutenVerdict(h, { name: "Fusilli", ingredients: "MAJSmjöl. Kan innehålla spår av VETE.", labels: ["Det överkorsade axet"] }), null);
  // Willys lists no ingredients: back to the name.
  assert.equal(glutenVerdict(h, { name: "Japansk Soja", ingredients: null, labels: [] })?.kind, "looks like");
  const wheat = { code: "S", name: "Mushroom Soy", ingredients: "Vatten, SOJABÖNOR, salt, VETE 11% (GLUTEN)." };
  assert.match(ruleProblems(h, wheat, "Gluten checked: I think it is fine").join(" "), /contains gluten: its ingredients on willys.se list "vete". This rule allows no exception/);
  assert.match(ruleProblems(h, { ...wheat, ingredients: "Mandel. Kan innehålla spår av VETE." }).join(" "), /may contain traces of gluten/);
});

test("a product's category is looked up on willys.se once, when a rule needs it", async () => {
  const store = new Store(":memory:");
  store.recordProduct({ code: "E1_ST", name: "Grillkrydda Påse", priceValue: 19.9 }, "regular");
  const lookups: string[] = [];
  const willys = { productInfo: async (code: string) => (lookups.push(code), { brand: "Eldorado", category: SPICES, ingredients: "Paprika, salt.", labels: [] }) };
  const ctx = { store, willys, household: household([{ brand: "Eldorado", category: "spices" }]) } as unknown as Context;
  // The brand is only in the product page here, so the category is needed
  // once the brand is known; a name match is enough to start the lookup.
  store.setProductDetails("E1_ST", { brand: "Eldorado", category: null as unknown as string });
  const first = await productFacts(ctx, "E1_ST");
  const second = await productFacts(ctx, "E1_ST");
  assert.deepEqual(lookups, ["E1_ST"]);
  assert.equal(first?.category, SPICES);
  assert.equal(second?.category, SPICES);
  assert.ok(brokenRule(ctx.household, second!));
});
