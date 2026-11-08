import { Recipe, type Step } from "./recipe.ts";

// Checks on a recipe beyond its shape, so a planner's recipe can be sent
// back with what to fix, and the cooking timeline the site shows.

export interface Timeline {
  // Minutes from starting to the last step done, timers included.
  totalMinutes: number;
  // Minutes the cook is busy: hands-on time and timers they stand over.
  activeMinutes: number;
  // When each step starts and finishes, in minutes from the start.
  steps: Map<string, { start: number; end: number }>;
  // Waits where the cook stands idle although a later step could be done.
  idle: { step: string; waitsFor: string; minutes: number; couldDo: string }[];
  // Passive parts that are done long before the step that needs them, such
  // as rice cooked half an hour before the curry. A hot oven can wait.
  early: { step: string; neededBy: string; minutes: number }[];
}

// Walks the steps in order with one cook: a step starts when the cook is
// free and the steps it is after are finished. A passive step's timer runs
// while the cook goes on; any other timer keeps the cook at the stove.
export function timeline(recipe: Recipe): Timeline {
  const steps = new Map<string, { start: number; end: number }>();
  const idle: Timeline["idle"] = [];
  let free = 0;
  let active = 0;
  recipe.steps.forEach((s, i) => {
    const deps = (s.after ?? []).filter((a) => steps.has(a));
    const ready = Math.max(0, ...deps.map((a) => steps.get(a)!.end));
    const start = Math.max(free, ready);
    if (start - free >= 3) {
      const waitsFor = deps.find((a) => steps.get(a)!.end === ready)!;
      const couldDo = recipe.steps.slice(i + 1).find((l) => l.kind !== "serve" && l.kind !== "assemble" && (l.after ?? []).every((a) => steps.has(a) && steps.get(a)!.end <= free));
      if (couldDo) idle.push({ step: s.id, waitsFor, minutes: start - free, couldDo: couldDo.id });
    }
    const handsOff = start + s.minutes;
    const wait = s.timer?.minutes ?? 0;
    free = s.passive ? handsOff : handsOff + wait;
    active += s.minutes + (s.passive ? 0 : wait);
    steps.set(s.id, { start, end: handsOff + wait });
  });
  const totalMinutes = Math.max(0, ...[...steps.values()].map((t) => t.end));
  const early: Timeline["early"] = [];
  for (const s of recipe.steps) {
    if (!s.passive || s.kind === "preheat" || s.kind === "rest") continue;
    const needer = recipe.steps.find((l) => l.after?.includes(s.id));
    if (!needer) continue;
    const gap = steps.get(needer.id)!.start - steps.get(s.id)!.end;
    if (gap >= 10) early.push({ step: s.id, neededBy: needer.id, minutes: gap });
  }
  return { totalMinutes, activeMinutes: active, steps, idle, early };
}

const HEAT: Step["kind"][] = ["preheat", "cook", "simmer", "bake"];

// The first step on the heat, when it starts 8 minutes or more in and the
// prep before it includes cutting it does not need: the cook could have
// had it cooking while they cut.
export function lateHeat(r: Recipe, t: Timeline): { step: string; minutes: number; cutting: string[] } | null {
  const first = r.steps.findIndex((s) => HEAT.includes(s.kind));
  if (first <= 0) return null;
  const heat = r.steps[first]!;
  const minutes = t.steps.get(heat.id)!.start;
  if (minutes < 8) return null;
  const needed = new Set<string>();
  const need = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const a of r.steps.find((s) => s.id === id)?.after ?? []) need(a);
  };
  for (const a of heat.after ?? []) need(a);
  const goesIn = new Set(heat.uses.map((u) => u.ingredient));
  const cutting = r.steps
    .slice(0, first)
    .filter((s) => s.kind === "prep" && !needed.has(s.id) && !s.uses.some((u) => goesIn.has(u.ingredient)))
    .map((s) => s.id);
  return cutting.length ? { step: heat.id, minutes, cutting } : null;
}

const NEEDS_TIMER: Step["kind"][] = ["preheat", "simmer", "bake", "rest"];

// What is wrong with a recipe, each problem a sentence the planner can act
// on. An empty list means it is fine to save and show.
export function recipeProblems(input: unknown): string[] {
  const parsed = Recipe.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`);
  const r = parsed.data;
  const problems: string[] = [];
  const ingredients = new Map(r.ingredients.map((i) => [i.id, i]));
  if (ingredients.size !== r.ingredients.length) problems.push("Two ingredients share an id.");
  const seen = new Set<string>();
  const used = new Map<string, number>();
  const preheated: number[] = [];
  for (const s of r.steps) {
    const label = `Step ${s.id}`;
    if (seen.has(s.id)) problems.push(`${label}: another step has the same id.`);
    for (const a of s.after ?? []) {
      if (a === s.id) problems.push(`${label} is after itself.`);
      else if (!seen.has(a)) problems.push(`${label} is after ${a}, which is not an earlier step.`);
    }
    for (const u of s.uses) {
      const ing = ingredients.get(u.ingredient);
      if (!ing) problems.push(`${label} uses ${u.ingredient}, which is not an ingredient.`);
      else used.set(u.ingredient, (used.get(u.ingredient) ?? 0) + (u.qty ?? 0));
    }
    if (s.passive && !s.timer) problems.push(`${label} is passive but has no timer.`);
    if (NEEDS_TIMER.includes(s.kind) && !s.timer) problems.push(`${label} (${s.kind}) needs a timer.`);
    if (s.timer?.upTo !== undefined && s.timer.upTo < s.timer.minutes) problems.push(`${label}: the timer's upTo is shorter than its minutes.`);
    if (s.kind === "preheat") {
      if (!s.oven) problems.push(`${label} preheats but gives no oven temperature.`);
      else preheated.push(s.oven.celsius);
    } else if (s.oven && !preheated.includes(s.oven.celsius)) {
      problems.push(`${label} uses the oven at ${s.oven.celsius}°C without an earlier step preheating it to that.`);
    }
    if (s.kind === "preheat" && !s.passive) problems.push(`${label}: preheating is passive, the cook does other steps meanwhile.`);
    seen.add(s.id);
  }
  for (const i of r.ingredients) {
    if (!used.has(i.id)) problems.push(`Ingredient ${i.id} is not used by any step.`);
    else if (i.qty !== undefined && used.get(i.id)! > i.qty * 1.01) problems.push(`The steps' partial amounts of ${i.id} add up to ${used.get(i.id)}, more than the ingredient list has (${i.qty}).`);
  }
  if (!problems.length) {
    const t = timeline(r);
    for (const w of t.idle) {
      problems.push(`Step ${w.step} waits ${w.minutes} minutes for ${w.waitsFor} while nothing else happens: move step ${w.couldDo} into that wait.`);
    }
    for (const w of t.early) {
      problems.push(`Step ${w.step} is ready ${w.minutes} minutes before step ${w.neededBy} needs it: start it later so it is not left standing.`);
    }
    const late = lateHeat(r, t);
    if (late) {
      problems.push(
        `Nothing is on the heat for the first ${late.minutes} minutes: step${late.cutting.length > 1 ? "s" : ""} ${late.cutting.join(", ")} cut${late.cutting.length > 1 ? "" : "s"} things step ${late.step} does not need. Start step ${late.step} as soon as its own ingredients are ready (passive, when it only needs turning now and then) and do that cutting while it cooks.`,
      );
    }
  }
  return problems;
}
