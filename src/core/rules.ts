import type { Context } from "./context.ts";
import type { Household } from "./household.ts";

// The household's shopping rules that code enforces, so they hold whatever
// the model decides: products to avoid and gluten. Each check names the
// problem; a deliberate exception has to be stated (see EXCEPTION), and a
// strict rule allows none.

// How a line or a tool call states a deliberate exception, for example
// "Brand exception: every other kvarg costs more than double" or
// "Gluten checked: Mrs Chang soy is gluten free".
export const EXCEPTION = /\b(brand exception|gluten checked)\s*:/i;
const BRAND_EXCEPTION = /\bbrand exception\s*:/i;
const GLUTEN_CHECKED = /\bgluten checked\s*:/i;

export interface AvoidRule {
  brand?: string;
  name?: string;
  category?: string;
  product?: string;
  strict?: boolean;
  note?: string;
}

export interface ProductFacts {
  code: string;
  name: string;
  brand?: string | null;
  // Willys's category path; undefined when not looked up.
  category?: string | null;
}

// English words members may use for Willys's Swedish categories.
const CATEGORY_WORDS: Record<string, string[]> = {
  spices: ["kryddor"],
  spice: ["kryddor"],
  seasoning: ["kryddor", "smaksättare"],
  sauces: ["såser"],
  dairy: ["mejeri"],
  cheese: ["ost"],
  meat: ["kött"],
  chicken: ["fågel", "kyckling"],
  fish: ["fisk"],
  frozen: ["fryst"],
  bread: ["bröd"],
  canned: ["konserver"],
  tinned: ["konserver"],
  snacks: ["snacks", "godis"],
  drinks: ["dryck"],
  pasta: ["pasta"],
  rice: ["ris"],
  vegetables: ["grönsaker"],
  fruit: ["frukt"],
};

export function avoidRules(household: Household): AvoidRule[] {
  const rules = household.config.rules;
  return [...(rules?.avoidBrands ?? []).map((brand) => ({ brand })), ...(rules?.avoid ?? [])];
}

const has = (text: string | null | undefined, words: string) => !!text && text.toLowerCase().includes(words.toLowerCase());

function categoryMatches(rule: string, path: string): boolean {
  const words = [rule, ...(CATEGORY_WORDS[rule.toLowerCase()] ?? [])];
  return path.split(">").some((part) => words.some((w) => has(part, w)));
}

// Whether a rule applies; null when it depends on a category not looked up
// yet.
export function ruleMatches(rule: AvoidRule, p: ProductFacts): boolean | null {
  if (rule.product && rule.product !== p.code) return false;
  if (rule.brand && !has(p.brand, rule.brand) && !has(p.name, rule.brand)) return false;
  if (rule.name && !has(p.name, rule.name)) return false;
  if (rule.category) {
    if (p.category === undefined || p.category === null) return null;
    if (!categoryMatches(rule.category, p.category)) return false;
  }
  return true;
}

function describe(rule: AvoidRule): string {
  const what = [rule.brand, rule.name && `"${rule.name}"`, rule.category && `in ${rule.category}`, rule.product && `product ${rule.product}`].filter(Boolean).join(" ");
  return `${what}${rule.note ? ` (${rule.note})` : ""}`;
}

// The first avoid rule a product breaks, if any. A strict rule wins over a
// lenient one, since it allows no exception.
export function brokenRule(household: Household, p: ProductFacts): AvoidRule | null {
  const broken = avoidRules(household).filter((r) => ruleMatches(r, p) === true);
  return broken.find((r) => r.strict) ?? broken[0] ?? null;
}

// Whether a product's category is needed to decide a rule.
export function needsCategory(household: Household, p: ProductFacts): boolean {
  return p.category === undefined && avoidRules(household).some((r) => ruleMatches(r, p) === null);
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

// What is wrong with buying a product, given what is known about it,
// unless the reason states an allowed exception.
export function ruleProblems(household: Household, p: ProductFacts, reason = ""): string[] {
  const problems: string[] = [];
  const rule = brokenRule(household, p);
  if (rule?.strict) {
    problems.push(`${p.name} (${p.code}) breaks the household rule "avoid ${describe(rule)}", which allows no exception: pick another product.`);
  } else if (rule && !BRAND_EXCEPTION.test(reason)) {
    problems.push(
      `${p.name} (${p.code}) breaks the household rule "avoid ${describe(rule)}": pick another product, or if every alternative costs more than double, start the reason with "Brand exception:" and say why.`,
    );
  }
  const gluten = glutenRisk(household, p.name);
  if (gluten && !GLUTEN_CHECKED.test(reason)) {
    problems.push(
      `${p.name} (${p.code}) looks like it contains gluten ("${gluten}"): pick a product labelled glutenfri, or if you know this one is gluten free, start the reason with "Gluten checked:" and say how you know (product_info shows its ingredients and labels).`,
    );
  }
  return problems;
}

// What the store knows about a product, looking up its category on
// willys.se first when a rule depends on it (and saving it for next time).
export async function productFacts(ctx: Context, code: string): Promise<ProductFacts | null> {
  const name = ctx.store.productName(code);
  if (!name) return null;
  const facts: ProductFacts = { code, name, brand: ctx.store.productBrand(code), category: ctx.store.productCategory(code) ?? undefined };
  if (!needsCategory(ctx.household, facts)) return facts;
  const details = await ctx.willys.productDetails(code);
  ctx.store.setProductDetails(code, details);
  return { ...facts, brand: details.brand ?? facts.brand, category: details.category };
}
