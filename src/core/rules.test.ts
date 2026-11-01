import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Household } from "./household.ts";
import { avoidedBrand, glutenRisk, ruleProblems } from "./rules.ts";

const household = { config: { rules: { avoidBrands: ["Garant", "Eldorado"], glutenFree: true, staples: [] } } } as unknown as Household;

test("an avoided brand is found by brand or by name, in any case", () => {
  assert.equal(avoidedBrand(household, { name: "Päron Kvarg 900g", brand: "Garant" }), "Garant");
  assert.equal(avoidedBrand(household, { name: "ELDORADO Krossade tomater" }), "Eldorado");
  assert.equal(avoidedBrand(household, { name: "Vanilj Mild Kvarg 1kg", brand: "Arla" }), null);
});

test("gluten words are flagged unless the product is labelled gluten free", () => {
  for (const name of ["Vetemjöl 2kg", "Spaghetti 500g", "Rågbröd", "Japansk Soja 150ml", "Äggnudlar 250g", "Couscous"]) assert.ok(glutenRisk(household, name), name);
  for (const name of ["Glutenfri Pasta Penne", "Mellanmjölk Laktosfri 1,5l", "Kokosmjölk 400ml", "Risnudlar 250g", "Majskorn 3-pack", "Potatismjöl", "Kycklinglårfilé 700g"]) assert.equal(glutenRisk(household, name), null, name);
});

test("households without the gluten rule get no gluten flags", () => {
  const any = { config: { rules: { avoidBrands: [], glutenFree: false, staples: [] } } } as unknown as Household;
  assert.equal(glutenRisk(any, "Spaghetti"), null);
});

test("a stated exception lets a flagged product through, and nothing else does", () => {
  const garant = { code: "G_ST", name: "Päron Kvarg 900g", brand: "Garant" };
  assert.match(ruleProblems(household, garant, "cheapest kvarg").join(" "), /brand the household avoids/);
  assert.deepEqual(ruleProblems(household, garant, "Brand exception: every other kvarg costs more than double"), []);
  const soy = { code: "S_ST", name: "Japansk Soja 150ml" };
  assert.match(ruleProblems(household, soy, "for the stir fry").join(" "), /contains gluten \("soja"\)/);
  assert.deepEqual(ruleProblems(household, soy, "Gluten checked: labelled tamari, made without wheat"), []);
});
