import type { Ingredient, Recipe, Step, Timer } from "./recipe.ts";

// Recipes saved as text (one ingredient per line and a numbered method)
// read as a Recipe, so the site can show them and cook mode can offer the
// timers the method mentions. Each step is given the ingredients its text
// names, so cook mode shows their amounts on the step.

const UNITS: [RegExp, number][] = [
  [/^(min|mins|minute|minutes|minut|minuter)$/, 1],
  [/^(h|hr|hrs|hour|hours|timme|timmar)$/, 60],
];

// "25 to 30 minutes", "25-30 min", "1 timme", "10 till 12 minuter".
const DURATION = /(\d+(?:[.,]\d+)?)(?:\s*(?:-|to|till|à|or|eller)\s*(\d+(?:[.,]\d+)?))?\s*([a-zåäö]+)/gi;

export function findTimer(text: string, label: string): Timer | undefined {
  for (const m of text.matchAll(DURATION)) {
    const unit = UNITS.find(([re]) => re.test(m[3]!.toLowerCase()));
    if (!unit) continue;
    const num = (s: string) => Number(s.replace(",", ".")) * unit[1];
    const minutes = num(m[1]!);
    const upTo = m[2] ? num(m[2]) : undefined;
    return { minutes, ...(upTo && upTo > minutes ? { upTo } : {}), label };
  }
  return undefined;
}

const KINDS: [RegExp, Step["kind"]][] = [
  [/\b(preheat|sätt ugnen|förvärm)/i, "preheat"],
  [/\b(bake|roast|oven|ugn|gratinera|baka|rosta)/i, "bake"],
  [/\b(simmer|sjud|puttra|koka ihop|låt koka|boil)/i, "simmer"],
  [/\b(rest|vila|låt stå|marinate|marinera)/i, "rest"],
  [/\b(serve|servera)/i, "serve"],
  [/\b(chop|cube|slice|grate|dice|peel|hacka|skär|tärna|riv|skala)/i, "prep"],
];

// "1400 g kycklinglårfilé (2 x 700 g)", "2 yellow onions", "1,45 kg ...":
// a leading amount and unit. Ranges and alternatives ("9 dl till 1 liter")
// stay as text.
const UNIT = "g|kg|hg|dl|cl|ml|l|liter|msk|tsk|krm|tbsp|tsp|st|cans?|tins?|packs?|punnets?|cloves?|klyftor|burkar?|paket|förp";
const AMOUNT = new RegExp(`^(\\d+(?:[.,]\\d+)?|\\d+\\/\\d+)\\s*(${UNIT})?\\s+(.+)$`, "i");
const PANTRY = /\s*\((?:pantry|at home|hemma|finns hemma)\)\s*$/i;

export function parseIngredient(line: string, id: string): Ingredient {
  const fromPantry = PANTRY.test(line);
  const text = line.replace(PANTRY, "").trim();
  const m = text.match(AMOUNT);
  if (!m || /^(?:-|to|till|or|eller|à)\b/i.test(m[3]!)) return { id, name: text, ...(fromPantry ? { fromPantry } : {}) };
  const [a, b] = m[1]!.includes("/") ? m[1]!.split("/").map(Number) : [Number(m[1]!.replace(",", ".")), 1];
  return { id, name: m[3]!, qty: a! / b!, ...(m[2] ? { unit: m[2] } : {}), ...(fromPantry ? { fromPantry } : {}) };
}

// Words in an ingredient line that say how it is prepared or how much,
// not what it is.
const NOT_FOOD = new Set(
  ("a an and or of to in on for with at the into about taste serve serving home pantry gluten free " +
    "chopped sliced diced cubed cubes cube grated minced crushed drained rinsed peeled patted dry halved quartered " +
    "strips strip moons half thumb pieces piece finely roughly thinly large small fresh ground whole " +
    "skinless boneless frozen yellow red green white juice zest " +
    "g kg hg dl cl ml l msk tsk krm tbsp tsp st can cans tin tins pack packs punnet punnets clove cloves " +
    "och eller till att med på i en ett hackad hackade skivad skivade riven rivna färsk färska gul gula röd röda vitt servering")
    .split(" "),
);

// Swedish ingredient words that English methods name differently.
const ALIASES: [string, string[]][] = [
  ["kyckling", ["chicken"]],
  ["nötfärs", ["mince", "beef"]],
  ["nöt", ["beef"]],
  ["fläsk", ["pork"]],
  ["vitlök", ["garlic"]],
  ["lök", ["onion"]],
  ["ingefära", ["ginger"]],
  ["pumpa", ["squash", "pumpkin"]],
  ["ris", ["rice"]],
  ["lime", ["lime"]],
];

const words = (text: string) => text.toLowerCase().match(/[a-zåäöéü]+/g) ?? [];

// What a method verb leaves an ingredient as: "Fry the tofu" makes "fried
// tofu". English only: Swedish adjectives agree with the noun, which a word
// list cannot do.
const DONE: Record<string, string> = Object.fromEntries(
  ("fry fried,brown browned,sear seared,soften softened,saute sautéed,sauté sautéed,cook cooked,boil boiled," +
    "roast roasted,bake baked,grill grilled,toast toasted,chop chopped,cube cubed,dice diced,slice sliced," +
    "grate grated,mince minced,peel peeled,crush crushed,mash mashed,marinate marinated,blanch blanched," +
    "steam steamed,drain drained,rinse rinsed,shred shredded,melt melted,char charred,caramelise caramelised," +
    "caramelize caramelized,poach poached,braise braised,stir-fry stir-fried")
    .split(",")
    .map((pair) => pair.split(" ") as [string, string]),
);
const singular = (w: string) => w.replace(/(?<=..)(es|s)$/, "");

// Two words name the same food: one is the other with an ending
// ("onion", "onions"), or they share a long start, as a Swedish compound
// and its short form do ("kycklinglårfilé", "kycklingen").
function sameFood(a: string, b: string): boolean {
  if (a === b) return true;
  const [sa, sb] = [singular(a), singular(b)];
  if (sa.length >= 4 && b.startsWith(sa)) return true;
  if (sb.length >= 4 && a.startsWith(sb)) return true;
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return n >= 6;
}

// The words an ingredient line is known by, the last word of each part
// ("firm tofu", "chili flakes") marked as its head. A line can hold several
// foods ("garlic, a thumb of ginger, grated").
function foodWords(i: Ingredient): { word: string; head: boolean }[] {
  const parts = i.name.replace(/\([^)]*\)/g, " ").split(/,|\bor\b|\beller\b/);
  return parts.flatMap((part) => {
    const ws = words(part).filter((w) => w.length >= 3 && !NOT_FOOD.has(w));
    return ws.flatMap((w, n) => {
      const head = n === ws.length - 1;
      const aliases = ALIASES.filter(([sv]) => w.startsWith(sv) || w.endsWith(sv)).flatMap(([, en]) => en);
      return [{ word: w, head }, ...aliases.map((a) => ({ word: a, head }))];
    });
  });
}

// The ingredients a step's text names, in the order of the list. When a
// word could be two ingredients ("mushrooms" against "mushrooms" and
// "mushroom soy"), the one it is the head of wins.
// Each is named, for later steps, by the verb before it in its sentence
// and the word the text calls it: "Fry the chicken strips" gives "fried
// chicken".
export function mentioned(text: string, ingredients: Ingredient[]): Step["uses"] {
  const known = ingredients.map((i) => ({ id: i.id, words: foodWords(i) }));
  const used = new Map<string, string | undefined>();
  const tokens = text.toLowerCase().match(/[a-zåäöéü]+(?:-[a-zåäöéü]+)?|[.!?;]/g) ?? [];
  let verb: string | undefined;
  for (const w of tokens) {
    if (/^[.!?;]$/.test(w)) verb = undefined;
    else if (DONE[w]) verb = DONE[w];
    if (w.length < 3 || NOT_FOOD.has(w) || DONE[w]) continue;
    const hits = known.flatMap((k) => k.words.filter((f) => sameFood(f.word, w)).map((f) => ({ id: k.id, head: f.head })));
    const heads = hits.filter((h) => h.head);
    for (const h of heads.length ? heads : hits) if (!used.has(h.id)) used.set(h.id, verb && `${verb} ${w}`);
  }
  return ingredients
    .filter((i) => used.has(i.id))
    .map((i) => {
      const becomes = used.get(i.id);
      return { ingredient: i.id, ...(becomes ? { becomes } : {}) };
    });
}

// What a timer read from text is called, by the step's kind.
const LABELS: Record<Step["kind"], string> = { preheat: "Oven", prep: "Prep", cook: "Cook", simmer: "Simmer", bake: "Oven", rest: "Rest", assemble: "Assemble", serve: "Serve" };

export function fromText(r: { name: string; servings: number | null; ingredients: string; method: string; notes?: string | null }): Recipe {
  const ingredients = r.ingredients
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line, i) => parseIngredient(line, `i${i + 1}`));
  const lines = r.method
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  const steps: Step[] = lines.map((text, i) => {
    const kind = KINDS.find(([re]) => re.test(text))?.[1] ?? "cook";
    const timer = findTimer(text, LABELS[kind]);
    return { id: `s${i + 1}`, kind, text, uses: mentioned(text, ingredients), minutes: 0, ...(timer ? { timer } : {}) };
  });
  if (steps.length === 1) steps.push({ id: "s2", kind: "serve", text: "Serve.", uses: [], minutes: 0 });
  return {
    name: r.name,
    servings: r.servings ?? 1,
    summary: "",
    equipment: [],
    ingredients: ingredients.length ? ingredients : [{ id: "i1", name: "See the method" }],
    steps,
    ...(r.notes ? { notes: r.notes } : {}),
  };
}
