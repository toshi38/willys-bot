import type { Recipe, Step, Timer } from "./recipe.ts";

// Recipes saved as text (one ingredient per line and a numbered method)
// read as a Recipe, so the site can show them and cook mode can offer the
// timers the method mentions. Steps use no ingredients: the site lists
// them all up front instead.

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

export function fromText(r: { name: string; servings: number | null; ingredients: string; method: string; notes?: string | null }): Recipe {
  const ingredients = r.ingredients
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((name, i) => ({ id: `i${i + 1}`, name }));
  const lines = r.method
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  const steps: Step[] = lines.map((text, i) => {
    const kind = KINDS.find(([re]) => re.test(text))?.[1] ?? "cook";
    const timer = findTimer(text, `Step ${i + 1}`);
    return { id: `s${i + 1}`, kind, text, uses: [], minutes: 0, ...(timer ? { timer } : {}) };
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
