import type { Household } from "./household.ts";

// The household's shopping rules that code enforces, so they hold whatever
// the model decides: brands to avoid and gluten. Each check names the
// problem; a deliberate exception has to be stated (see EXCEPTION).

// How a line or a tool call states a deliberate exception, for example
// "Brand exception: every other kvarg costs more than double" or
// "Gluten checked: Mrs Chang soy is gluten free".
export const EXCEPTION = /\b(brand exception|gluten checked)\s*:/i;

// The avoided brand a product belongs to, matched on its brand or name.
export function avoidedBrand(household: Household, product: { name: string; brand?: string | null }): string | null {
  const text = `${product.brand ?? ""} ${product.name}`.toLowerCase();
  return (household.config.rules?.avoidBrands ?? []).find((b) => text.includes(b.toLowerCase())) ?? null;
}

// Words in a Swedish or English product name that usually mean gluten.
// Labelled gluten-free products pass. It is a safety net that makes the
// model look twice, not a full check: any product can still contain gluten.
const GLUTEN = ["vete", "råg", "korn", "dinkel", "durum", "pasta", "spaghetti", "makaron", "lasagne", "bröd", "tortilla", "couscous", "bulgur", "panko", "ströbröd", "soja", "teriyaki", "öl ", "wheat", "rye", "barley", "spelt", "bread", "noodle", "nudlar", "flour"];
const NOT_GLUTEN = ["glutenfri", "gluten free", "gluten-free", "utan gluten", "majskorn", "risnudlar", "rice noodle", "majsmjöl", "rismjöl", "potatismjöl", "majstortilla"];

export function glutenRisk(household: Household, name: string): string | null {
  if (!household.config.rules?.glutenFree) return null;
  const n = ` ${name.toLowerCase()} `;
  if (NOT_GLUTEN.some((w) => n.includes(w))) return null;
  return GLUTEN.find((w) => n.includes(w))?.trim() ?? null;
}

// What is wrong with buying a product, unless the reason states an
// exception.
export function ruleProblems(household: Household, product: { code: string; name: string; brand?: string | null }, reason = ""): string[] {
  if (EXCEPTION.test(reason)) return [];
  const problems: string[] = [];
  const brand = avoidedBrand(household, product);
  if (brand) {
    problems.push(
      `${product.name} (${product.code}) is ${brand}, a brand the household avoids: pick another brand, or if every other brand costs more than double, start the reason with "Brand exception:" and say why.`,
    );
  }
  const gluten = glutenRisk(household, product.name);
  if (gluten) {
    problems.push(
      `${product.name} (${product.code}) looks like it contains gluten ("${gluten}"): pick a product labelled glutenfri, or if you know this one is gluten free, start the reason with "Gluten checked:" and say how you know.`,
    );
  }
  return problems;
}
