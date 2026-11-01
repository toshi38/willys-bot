import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { leakProblems } from "./leaks.ts";
import { fromText } from "./legacy.ts";
import { Recipe } from "./recipe.ts";
import { buildSite, cookData, dishSlugs, isoWeek, recipePage, slug, weekLabel, type SiteWeek } from "./site.ts";

const skill = readFileSync(new URL("../../.claude/skills/recipe-writing/SKILL.md", import.meta.url), "utf8");
const example = Recipe.parse(JSON.parse(skill.match(/```json\n([\s\S]*?)```/)![1]!));
const config = { title: "Kitchen", language: "en" as const };

const week: SiteWeek = {
  pickup: "2026-10-30",
  dishes: [
    { name: example.name, portions: 6, recipe: example, fromText: false },
    { name: "Köttfärssås <b>& pasta</b>", portions: 4, recipe: fromText({ name: "x", servings: 4, ingredients: "500 g färs", method: "1. Bryn färsen.\n2. Låt puttra 20 minuter." }), fromText: true },
    { name: "Köttfärssås & pasta", portions: 4, recipe: fromText({ name: "x", servings: 4, ingredients: "a", method: "1. a\n2. b" }), fromText: true },
  ],
};

test("weeks are labelled with the ISO week and the days the food is for", () => {
  assert.equal(isoWeek("2026-10-30"), 44);
  assert.equal(isoWeek("2027-01-01"), 53);
  assert.equal(isoWeek("2026-01-01"), 1);
  assert.equal(weekLabel("2026-10-30", "en"), "W44 · Fri 30 Oct to Thu 5 Nov");
  assert.equal(weekLabel("2026-10-30", "sv"), "V44 · fre 30 okt till tor 5 nov");
});

test("dish paths are plain ASCII and unique within a week", () => {
  assert.equal(slug("Lättare krämig champinjonsås"), "lattare-kramig-champinjonsas");
  assert.deepEqual(dishSlugs(week).slice(1), ["kottfarssas-b-pasta-b", "kottfarssas-pasta"]);
});

test("the site has an index, a page per week and two pages per dish, all linked relatively", () => {
  const files = buildSite(config, [week], { "style.css": "", "cook.js": "" });
  const slugs = dishSlugs(week);
  assert.deepEqual([...files.keys()].sort(), [
    "2026-10-30/index.html",
    ...slugs.flatMap((s) => [`2026-10-30/${s}/cook/index.html`, `2026-10-30/${s}/index.html`]),
    "cook.js",
    "index.html",
    "style.css",
  ].sort());
  assert.match(files.get("index.html")!, /<a href="2026-10-30\/">W44 · Fri 30 Oct to Thu 5 Nov<\/a>/);
  assert.ok(![...files.values()].some((html) => /(href|src)="\//.test(html)), "no absolute links");
});

test("names and steps are escaped on every page", () => {
  const files = buildSite(config, [week], {});
  for (const [path, html] of files) assert.ok(!html.includes("<b>& pasta</b>"), path);
  const cook = files.get(`2026-10-30/${dishSlugs(week)[1]}/cook/index.html`)!;
  assert.ok(!/<\/b>|<b>&/.test(cook.split('id="data">')[1]!.split("</script>")[0]!), "the embedded JSON has no raw tags");
});

test("a structured recipe shows its time, ingredient amounts and step timers", () => {
  const html = recipePage(config, week, 0);
  assert.match(html, /Ready in about 48 min \(31 min hands-on\)/);
  assert.match(html, /<b>1400 g<\/b> chicken thigh fillets<span class="prep">, in bite-size pieces<\/span>/);
  assert.match(html, /⏱ 20 to 25 min/);
  assert.match(html, /<a class="button primary" href="cook\/">/);
});

test("cook mode gets each step's ingredients spelled out, and partial amounts", () => {
  const r = structuredClone(example);
  r.steps.find((s) => s.id === "brown")!.uses = [{ ingredient: "oil" }, { ingredient: "chicken", qty: 700 }];
  const data = cookData(config, { ...week, dishes: [{ ...week.dishes[0]!, recipe: r }] }, 0);
  assert.equal(data.key, "2026-10-30/coconut-chicken-and-butternut-curry-with-rice");
  const brown = data.steps.find((s) => s.id === "brown")!;
  assert.deepEqual(brown.uses, ["<b>2 tbsp</b> oil", '<b>700 g</b> chicken thigh fillets<span class="prep">, in bite-size pieces</span>']);
  assert.deepEqual(brown.chips, ["High heat"]);
  assert.equal(data.steps.find((s) => s.id === "curry")!.passive, true);
});

test("a recipe read from text has no time estimate but keeps its method's timers", () => {
  const html = recipePage(config, week, 1);
  assert.doesNotMatch(html, /Ready in/);
  assert.match(html, /⏱ 20 min/);
});

test("leaks: secret values, emails and token-shaped strings are caught, recipes are not", () => {
  const recipeText = JSON.stringify(week);
  assert.deepEqual(leakProblems("week", recipeText, ["hunter22-secret"]), []);
  assert.deepEqual(leakProblems("week", `${recipeText} hunter22-secret`, ["hunter22-secret"]), ["week contains the value of a secret."]);
  assert.deepEqual(leakProblems("week", "ask carin@lau.engineering"), ["week contains what looks like an email address."]);
  assert.deepEqual(leakProblems("week", "key re_AbCdEfGhIjKlMnOpQrSt"), ["week contains what looks like a Resend API key."]);
  assert.deepEqual(leakProblems("week", "x Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg9Q y"), ["week contains a long token-like string (Zm9vYm...)."]);
  assert.ok(leakProblems("week", "https://user:pass@example.com/x").includes("week contains what looks like a URL with credentials."));
});
