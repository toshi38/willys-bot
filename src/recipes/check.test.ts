import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recipeProblems, timeline } from "./check.ts";
import { fromText, mentioned, parseIngredient } from "./legacy.ts";
import { Recipe, amount } from "./recipe.ts";

const skill = readFileSync(new URL("../../.claude/skills/recipe-writing/SKILL.md", import.meta.url), "utf8");
const example = Recipe.parse(JSON.parse(skill.match(/```json\n([\s\S]*?)```/)![1]!));

const with_ = (change: (r: Recipe) => void): Recipe => {
  const r = structuredClone(example);
  change(r);
  return r;
};

test("the skill's example recipe passes every check", () => {
  assert.deepEqual(recipeProblems(example), []);
});

test("the timeline overlaps passive steps and counts the cook's busy time", () => {
  const t = timeline(example);
  // Cut the chicken 5, brown it 2 then 10 on its own while the vegetables
  // are chopped (10), soften 5, curry 1 then 20 on its own, rice goes on
  // during the curry, serve 2 once the curry is done.
  assert.equal(t.totalMinutes, 45);
  assert.equal(t.activeMinutes, 28);
  assert.deepEqual(t.steps.get("rice"), { start: 23, end: 38 });
  assert.deepEqual(t.idle, []);
  assert.deepEqual(t.early, []);
});

test("a recipe that is not the right shape says which field is wrong", () => {
  const problems = recipeProblems({ ...example, steps: [{ id: "Bad Id", kind: "fry", text: "", minutes: 1 }] });
  assert.ok(problems.some((p) => p.startsWith("steps")), problems.join("\n"));
});

test("references must point at real ingredients and earlier steps", () => {
  const r = with_((r) => {
    r.steps[0]!.uses.push({ ingredient: "shallot" });
    r.steps[0]!.after = ["finish"];
  });
  const problems = recipeProblems(r);
  assert.ok(problems.includes("Step cut-chicken uses shallot, which is not an ingredient."), problems.join("\n"));
  assert.ok(problems.includes("Step cut-chicken is after finish, which is not an earlier step."), problems.join("\n"));
});

test("every ingredient is used, and partial amounts do not add up to more than the list", () => {
  const r = with_((r) => {
    r.ingredients.push({ id: "coriander", name: "coriander" });
    r.steps.find((s) => s.id === "brown")!.uses = [{ ingredient: "oil" }, { ingredient: "chicken", qty: 900 }];
    r.steps.find((s) => s.id === "curry")!.uses.find((u) => u.ingredient === "chicken")!.qty = 900;
  });
  assert.deepEqual(recipeProblems(r), [
    "The steps' partial amounts of chicken add up to 1800, more than the ingredient list has (1400).",
    "Ingredient coriander is not used by any step.",
  ]);
});

test("waiting steps need timers, and passive ones need one too", () => {
  const r = with_((r) => {
    delete r.steps.find((s) => s.id === "curry")!.timer;
  });
  assert.deepEqual(recipeProblems(r), ["Step curry is passive but has no timer.", "Step curry (simmer) needs a timer."]);
});

test("the oven is preheated, to the temperature used, in a passive step", () => {
  const bake = { id: "bake", kind: "bake" as const, text: "Bake.", uses: [], minutes: 1, timer: { minutes: 20, label: "Oven" }, passive: true, oven: { celsius: 200, fan: true } };
  const noPreheat = with_((r) => r.steps.splice(1, 0, bake));
  assert.ok(recipeProblems(noPreheat).includes("Step bake uses the oven at 200°C without an earlier step preheating it to that."));
  const preheat = { id: "preheat", kind: "preheat" as const, text: "Heat the oven to 200°C.", uses: [], minutes: 0, timer: { minutes: 15, label: "Oven 200°C" }, oven: { celsius: 200, fan: true } };
  const notPassive = with_((r) => r.steps.splice(0, 0, preheat));
  assert.ok(recipeProblems(notPassive).includes("Step preheat: preheating is passive, the cook does other steps meanwhile."));
});

test("idle waits and parts done far too early are flagged with what to move", () => {
  // Waiting at the stove for the curry with the rice still to start.
  const idle = with_((r) => {
    const rice = r.steps.find((s) => s.id === "rice")!;
    r.steps.find((s) => s.id === "finish")!.after = ["curry"];
    r.steps = r.steps.filter((s) => s.id !== "rice");
    const wait = { id: "taste", kind: "cook" as const, text: "Taste the curry.", uses: [], minutes: 1, after: ["curry"] };
    r.steps.splice(r.steps.length - 1, 0, wait, rice);
  });
  assert.deepEqual(recipeProblems(idle), ["Step taste waits 20 minutes for curry while nothing else happens: move step rice into that wait."]);
  // Rice first, done half an hour before the curry.
  const early = with_((r) => {
    const rice = r.steps.find((s) => s.id === "rice")!;
    r.steps = [rice, ...r.steps.filter((s) => s.id !== "rice")];
  });
  assert.deepEqual(recipeProblems(early), ["Step rice is ready 31 minutes before step finish needs it: start it later so it is not left standing."]);
});

test("a recipe saved as text reads as steps with the timers its method mentions", () => {
  const r = fromText({
    name: "Coconut chicken and butternut curry with rice",
    servings: 6,
    ingredients: "1400 g kycklinglårfilé (2 x 700 g)\n1 kg butternutpumpa\n\nsalt",
    method:
      "1. Cube the butternut and chop the onion.\n2. Brown the chicken in a pot, set aside.\n3. Add the butternut, chicken and coconut milk. Simmer 25 to 30 minutes until tender.\n4. Finish with lime juice and salt. Serve with rice.",
  });
  assert.deepEqual(r.ingredients, [
    { id: "i1", name: "kycklinglårfilé (2 x 700 g)", qty: 1400, unit: "g" },
    { id: "i2", name: "butternutpumpa", qty: 1, unit: "kg" },
    { id: "i3", name: "salt" },
  ]);
  assert.deepEqual(r.steps.map((s) => s.kind), ["prep", "cook", "simmer", "serve"]);
  assert.deepEqual(r.steps[2]!.timer, { minutes: 25, upTo: 30, label: "Simmer" });
  assert.equal(r.steps[0]!.timer, undefined);
  assert.deepEqual(r.steps.map((s) => s.uses.map((u) => u.ingredient)), [["i2"], ["i1"], ["i1", "i2"], ["i3"]]);
});

test("a text step is given the ingredients it names, the food a word is the head of winning", () => {
  const ingredients = [
    "250 g mushrooms, sliced",
    "Mrs Chang mushroom soy (at home)",
    "garlic, a thumb of ginger, grated",
    "cornflour, 1 tsp sugar, chili flakes",
    "1 kg butternutpumpa",
    "limes (juice and zest)",
  ].map((l, i) => parseIngredient(l, `i${i + 1}`));
  const uses = (text: string) => mentioned(text, ingredients).map((u) => u.ingredient);
  assert.deepEqual(uses("Fry the onion and mushrooms."), ["i1"]);
  assert.deepEqual(uses("Mix the soy, sugar and chili."), ["i2", "i4"]);
  assert.deepEqual(uses("Add garlic and ginger for a minute."), ["i3"]);
  assert.deepEqual(uses("Cube the butternut. Finish with lime juice."), ["i5", "i6"]);
  assert.deepEqual(uses("Stir and serve."), []);
  // What each is called by a later step: the verb before it in its sentence.
  assert.deepEqual(mentioned("Fry the chicken strips until cooked, set aside. Add the mushrooms.", [parseIngredient("900 g chicken breast", "c"), ingredients[0]!]), [
    { ingredient: "c", becomes: "fried chicken" },
    { ingredient: "i1" },
  ]);
  assert.deepEqual(mentioned("Cube the butternut and chop the onion.", [ingredients[4]!, parseIngredient("2 onions", "o")]), [
    { ingredient: "i5", becomes: "cubed butternut" },
    { ingredient: "o", becomes: "chopped onion" },
  ]);
});

test("timers are read from Swedish methods and hours", () => {
  const r = fromText({ name: "Gryta", servings: 4, ingredients: "x", method: "1. Låt puttra 10 till 12 minuter.\n2. Sätt ugnen på 200 grader och baka 1 timme." });
  assert.deepEqual(r.steps.map((s) => [s.kind, s.timer?.minutes, s.timer?.upTo]), [["simmer", 10, 12], ["preheat", 60, undefined]]);
});

test("amounts drop trailing zeros", () => {
  assert.equal(amount(1.5, "dl"), "1.5 dl");
  assert.equal(amount(2, undefined), "2");
  assert.equal(amount(undefined, "g"), "");
});

test("ingredients saved as text have their amount, unit and pantry note read out", () => {
  const p = (line: string) => parseIngredient(line, "x");
  assert.deepEqual(p("2 yellow onions"), { id: "x", name: "yellow onions", qty: 2 });
  assert.deepEqual(p("2 cans coconut milk (pantry)"), { id: "x", name: "coconut milk", qty: 2, unit: "cans", fromPantry: true });
  assert.deepEqual(p("1,45 kg kycklingfilé (eller 1,3 kg fläskytterfilé)"), { id: "x", name: "kycklingfilé (eller 1,3 kg fläskytterfilé)", qty: 1.45, unit: "kg" });
  assert.deepEqual(p("1/2 tsk salt"), { id: "x", name: "salt", qty: 0.5, unit: "tsk" });
  assert.deepEqual(p("2 limes (juice and zest)"), { id: "x", name: "limes (juice and zest)", qty: 2 });
  assert.deepEqual(p("4 garlic cloves"), { id: "x", name: "garlic cloves", qty: 4 });
  // Ranges and alternatives stay whole rather than half read.
  assert.deepEqual(p("9 dl till 1 liter svampbuljong (glutenfri)"), { id: "x", name: "9 dl till 1 liter svampbuljong (glutenfri)" });
  assert.deepEqual(p("450 till 500 g babyspenat"), { id: "x", name: "450 till 500 g babyspenat" });
  assert.deepEqual(p("salt, pepper, oil"), { id: "x", name: "salt, pepper, oil" });
  assert.deepEqual(p("rice to serve (pantry)"), { id: "x", name: "rice to serve", fromPantry: true });
});

test("cutting everything before anything is on the heat is flagged, when some of it is for later", () => {
  // The vegetables chopped first, the chicken only browned once they are done.
  const cutFirst = with_((r) => {
    const chop = r.steps.find((s) => s.id === "chop")!;
    r.steps = [chop, ...r.steps.filter((s) => s.id !== "chop")];
  });
  assert.ok(
    recipeProblems(cutFirst).includes(
      "Nothing is on the heat for the first 15 minutes: step chop cuts things step brown does not need. Start step brown as soon as its own ingredients are ready (passive, when it only needs turning now and then) and do that cutting while it cooks.",
    ),
  );
  // Cutting only what goes in first is fine, however long it takes.
  const slowCut = with_((r) => {
    r.steps.find((s) => s.id === "cut-chicken")!.minutes = 12;
  });
  assert.deepEqual(recipeProblems(slowCut), []);
});
