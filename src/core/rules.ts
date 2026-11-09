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
  // The product page's ingredient list: undefined when not looked up, null
  // when Willys lists none.
  ingredients?: string | null;
  labels?: string[];
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
// Labelled gluten-free products pass. It is a safety net for products whose
// ingredients are not known, not a full check.
const GLUTEN = ["vete", "råg", "korn", "dinkel", "durum", "pasta", "spaghetti", "makaron", "lasagne", "bröd", "tortilla", "couscous", "bulgur", "panko", "ströbröd", "soja", "teriyaki", "öl ", "wheat", "rye", "barley", "spelt", "bread", "noodle", "nudlar", "flour"];
const NOT_GLUTEN = ["glutenfri", "gluten free", "gluten-free", "utan gluten", "majskorn", "risnudlar", "rice noodle", "majsmjöl", "rismjöl", "potatismjöl", "majstortilla"];

// Labels on the product page that mean it is gluten free.
const GLUTEN_FREE_LABEL = /fri från gluten|glutenfri|gluten free|överkorsade axet/i;

// Grains and words in an ingredient list that mean gluten, including a
// declared trace ("Kan innehålla spår av VETE"). Oats count: only oats
// labelled gluten free are safe, and those pass on their label.
// Each matches inside a Swedish compound ("VETEmjöl", "KORNmaltsirap");
// WHOLE_WORDS only on their own, since they hide in other words
// ("emmentaler", "goats").
const GLUTEN_SOURCES = ["vete", "råg", "korn", "havre", "dinkel", "spelt", "durum", "kamut", "enkorn", "malt", "gluten", "bulgur", "couscous", "mannagryn", "semolina", "seitan", "ströbröd", "panko", "wheat", "barley"];
const WHOLE_WORDS = ["emmer", "rye", "oat", "oats"];
// Words that contain one of those but are gluten free.
const GLUTEN_FREE_WORDS = /glutenfri\w* havre\w*|gluten[- ]free oats?|bovete|majskorn|pepparkorn|senapskorn|korianderkorn|fänkålskorn|kumminkorn|maltodextrin|maltitol|maltos|glutenfri\w*|gluten free|gluten-free|buckwheat/g;

// The gluten source named in an ingredient list, if any, and whether it is
// only a declared trace.
export function glutenInIngredients(ingredients: string): { word: string; trace: boolean } | null {
  const text = ingredients.toLowerCase().replace(GLUTEN_FREE_WORDS, " ");
  for (const clause of text.split(/[.;]/)) {
    const words = clause.split(/[^a-zåäöéü]+/).filter(Boolean);
    const hit = GLUTEN_SOURCES.find((g) => words.some((w) => w.includes(g))) ?? WHOLE_WORDS.find((g) => words.includes(g));
    if (hit) return { word: hit, trace: /spår|traces/.test(clause) };
  }
  return null;
}

export type GlutenVerdict =
  | { kind: "contains"; word: string; trace: boolean }
  | { kind: "looks like"; word: string };

// Whether a product breaks a gluten-free household's rule. A gluten-free
// label passes; otherwise the ingredient list decides when Willys has one,
// and the product's name when it does not.
export function glutenVerdict(household: Household, p: Pick<ProductFacts, "name" | "ingredients" | "labels">): GlutenVerdict | null {
  if (!household.config.rules?.glutenFree) return null;
  if (p.labels?.some((l) => GLUTEN_FREE_LABEL.test(l))) return null;
  if (p.ingredients) {
    const hit = glutenInIngredients(p.ingredients);
    return hit ? { kind: "contains", ...hit } : null;
  }
  const n = ` ${p.name.toLowerCase()} `;
  if (NOT_GLUTEN.some((w) => n.includes(w))) return null;
  const word = GLUTEN.find((w) => n.includes(w))?.trim();
  return word ? { kind: "looks like", word } : null;
}

// Whether looking up the product page could change a rule's verdict.
export function needsLookup(household: Household, p: ProductFacts): boolean {
  return needsCategory(household, p) || (!!household.config.rules?.glutenFree && p.ingredients === undefined);
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
  const gluten = glutenVerdict(household, p);
  if (gluten?.kind === "contains") {
    problems.push(
      `${p.name} (${p.code}) ${gluten.trace ? "may contain traces of" : "contains"} gluten: its ingredients on willys.se list "${gluten.word}". This rule allows no exception: pick a product labelled glutenfri or one whose ingredients have no gluten.`,
    );
  } else if (gluten && !GLUTEN_CHECKED.test(reason)) {
    problems.push(
      `${p.name} (${p.code}) looks like it contains gluten ("${gluten.word}") and Willys lists no ingredients for it: pick a product labelled glutenfri, or if you know this one is gluten free, start the reason with "Gluten checked:" and say how you know.`,
    );
  }
  return problems;
}

// What the store knows about a product, from its search results and any
// product page fetched before.
export function knownFacts(ctx: Context, code: string, name = ctx.store.productName(code)): ProductFacts | null {
  if (!name) return null;
  const contents = ctx.store.productContents(code);
  return {
    code,
    name,
    brand: ctx.store.productBrand(code),
    category: ctx.store.productCategory(code) ?? undefined,
    ...(contents ? { ingredients: contents.ingredients, labels: contents.labels } : {}),
  };
}

// What the store knows about a product, fetching its page on willys.se
// first when a rule depends on it (and saving it for next time).
export async function productFacts(ctx: Context, code: string): Promise<ProductFacts | null> {
  const facts = knownFacts(ctx, code);
  if (!facts || !needsLookup(ctx.household, facts)) return facts;
  // Without the page, gluten falls back to the name check; a category rule
  // cannot be decided at all.
  let page;
  try {
    page = await ctx.willys.productInfo(code);
  } catch (err) {
    if (needsCategory(ctx.household, facts)) throw err;
    return facts;
  }
  ctx.store.setProductDetails(code, page);
  return { ...facts, brand: page.brand ?? facts.brand, category: page.category, ingredients: page.ingredients, labels: page.labels };
}
