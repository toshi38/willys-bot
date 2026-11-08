import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { leakProblems } from "./leaks.ts";
import { fromText } from "./legacy.ts";
import { Recipe } from "./recipe.ts";
import { buildSite, cookData, dishSlugs, isoWeek, recipePage, slug, SiteConfig, SiteWeek, weekName, weekPage, weekRange } from "./site.ts";

const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL(".claude/skills/recipe-writing/SKILL.md", root), "utf8");
const example = Recipe.parse(JSON.parse(skill.match(/```json\n([\s\S]*?)```/)![1]!));
const config = { title: "Food", language: "en" as const };
const assets = Object.fromEntries(readdirSync(new URL("site/", root)).map((f) => [f, readFileSync(new URL(`site/${f}`, root), "utf8")]));

const week: SiteWeek = {
  pickup: "2026-10-30",
  dishes: [
    { name: example.name, portions: 6, recipe: example, fromText: false },
    { name: "Köttfärssås <b>& pasta</b>", portions: 4, recipe: fromText({ name: "x", servings: 4, ingredients: "500 g färs", method: "1. Bryn färsen.\n2. Låt puttra 20 minuter." }), fromText: true },
    { name: "Köttfärssås & pasta", portions: 4, recipe: fromText({ name: "x", servings: 4, ingredients: "a", method: "1. a\n2. b" }), fromText: true },
  ],
};

// Every relative href and src on every page, resolved against the page.
function links(files: Map<string, string>): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const [path, html] of files) {
    if (!path.endsWith(".html")) continue;
    for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const url = m[1]!;
      if (/^(https?:)?\/\//.test(url)) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), url.split("#")[0]!));
      out.push({ from: path, to: target.endsWith("/") || target === "." ? posix.join(target, "index.html") : target });
    }
  }
  return out;
}

test("weeks are named by ISO week, with the days the food is for", () => {
  assert.equal(isoWeek("2026-10-30"), 44);
  assert.equal(isoWeek("2027-01-01"), 53);
  assert.equal(isoWeek("2026-01-01"), 1);
  assert.equal(weekName("2026-10-30", "en"), "Week 44");
  assert.equal(weekRange("2026-10-30", "en"), "Fri 30 Oct to Thu 5 Nov");
  assert.equal(weekName("2026-10-30", "sv"), "Vecka 44");
  assert.equal(weekRange("2026-10-30", "sv"), "fre 30 okt till tor 5 nov");
});

test("dish paths are plain ASCII and unique within a week", () => {
  assert.equal(slug("Lättare krämig champinjonsås"), "lattare-kramig-champinjonsas");
  assert.deepEqual(dishSlugs(week).slice(1), ["kottfarssas-b-pasta-b", "kottfarssas-pasta"]);
});

test("the site has an index, a page per week and two pages per dish, and every link lands on a file", () => {
  const files = buildSite(config, [week], assets);
  const slugs = dishSlugs(week);
  assert.deepEqual(
    [...files.keys()].filter((p) => p.endsWith(".html")).sort(),
    ["2026-10-30/index.html", ...slugs.flatMap((s) => [`2026-10-30/${s}/cook/index.html`, `2026-10-30/${s}/index.html`]), "index.html"].sort(),
  );
  const all = links(files);
  assert.ok(all.length > 20);
  for (const l of all) assert.ok(files.has(l.to), `${l.from} links to ${l.to}, which is not in the site`);
  assert.ok(![...files.values()].some((html) => /(href|src)="\//.test(html)), "no absolute links");
});

test("an empty site still builds, with a message instead of weeks", () => {
  const files = buildSite(config, [], assets);
  assert.match(files.get("index.html")!, /No weeks yet\./);
  for (const l of links(files)) assert.ok(files.has(l.to), `${l.from} links to ${l.to}`);
});

test("names and steps are escaped on every page, including the data cook mode reads", () => {
  const files = buildSite(config, [week], assets);
  for (const [path, html] of files) if (path.endsWith(".html")) assert.ok(!html.includes("<b>& pasta</b>"), path);
  const cook = files.get(`2026-10-30/${dishSlugs(week)[1]}/cook/index.html`)!;
  const json = cook.split('id="data">')[1]!.split("</script>")[0]!;
  assert.doesNotMatch(json, /</, "the embedded JSON has no raw <");
  assert.equal(JSON.parse(json).name, "Köttfärssås <b>& pasta</b>");
});

test("the week page counts the dinners and colours each dish and its steps", () => {
  const html = weekPage(config, week);
  assert.match(html, /<h1>Three dinners<\/h1>/);
  assert.match(html, /Fri 30 Oct to Thu 5 Nov/);
  assert.match(html, /class="dish-card d-0" href="coconut-chicken-and-butternut-curry-with-rice\/"/);
  assert.match(html, /<span>48 min<\/span><span>31 min hands-on<\/span><span>6 portions<\/span>/);
  assert.match(html, /<span>2 steps<\/span><span>4 portions<\/span>/, "a text recipe shows its step count");
  assert.match(html, /<i class="k-prep"><\/i><i class="k-cook"><\/i>/);
});

test("a structured recipe shows its times, amounts, steps by kind and timers", () => {
  const html = recipePage(config, week, 0);
  assert.match(html, /<b>48<small> min<\/small><\/b><span>Total<\/span>/);
  assert.match(html, /<b>31<small> min<\/small><\/b><span>Hands-on<\/span>/);
  assert.match(html, /<span class="amt">1400 g<\/span><span><span class="n">chicken thigh fillets<\/span><span class="prep">, in bite-size pieces<\/span>/);
  assert.match(html, /<span class="amt">6 dl<\/span><span><span class="n">jasmine rice<\/span><span class="home">at home<\/span>/);
  assert.match(html, /<li class="k-simmer"><div class="num">4<\/div><div><div class="kind">Simmer <span>· Low heat<\/span><\/div>/);
  assert.match(html, /<span class="tag">20 to 25 min, runs on its own<\/span>/);
  assert.match(html, /<a class="cta" href="cook\/">/);
  assert.match(html, /<div class="notes">Freezes well without the rice\.<\/div>/);
});

test("a recipe read from text has no time estimate but keeps its method's timers", () => {
  const html = recipePage(config, week, 1);
  assert.doesNotMatch(html, /Total/);
  assert.match(html, /<span class="tag">20 min<\/span>/);
  const long = { ...week, dishes: [{ ...week.dishes[1]!, recipe: fromText({ name: "Chili", servings: 6, ingredients: "x", method: "1. Brown.\n2. Simmer for 2 to 2.5 hours." }) }] };
  assert.match(recipePage(config, long, 0), /<span class="tag">2 h to 2 h 30 min<\/span>/);
  assert.equal(cookData(config, long, 0).steps[1]!.startLabel, "Start simmer timer");
});

test("cook mode gets each step's ingredients, labels and partial amounts spelled out", () => {
  const r = structuredClone(example);
  r.steps.find((s) => s.id === "brown")!.uses = [{ ingredient: "oil" }, { ingredient: "chicken", qty: 700 }];
  const data = cookData(config, { ...week, dishes: [{ ...week.dishes[0]!, recipe: r }] }, 0);
  assert.equal(data.key, "2026-10-30/coconut-chicken-and-butternut-curry-with-rice");
  const brown = data.steps.find((s) => s.id === "brown")!;
  assert.deepEqual(brown.uses, ["<b>2 tbsp</b> oil", '<b>700 g</b> chicken thigh fillets<span class="prep">, in bite-size pieces</span>']);
  assert.deepEqual(brown.chips, ["High heat"]);
  const rice = data.steps.find((s) => s.id === "rice")!;
  assert.equal(rice.startLabel, "Start rice timer");
  assert.equal(rice.timerText, "12 to 15 min");
  assert.equal(rice.passive, true);
});

test("Swedish sites get Swedish labels", () => {
  const sv = { title: "Mat", language: "sv" as const };
  assert.match(weekPage(sv, week), /<h1>Tre middagar<\/h1>/);
  assert.match(recipePage(sv, week, 0), /Laga steg för steg/);
  assert.equal(cookData(sv, week, 0).steps.find((s) => s.id === "rice")!.startLabel, "Starta timer: Rice");
});

test("the committed site data parses and builds", () => {
  const dir = new URL("site-data/", root);
  SiteConfig.parse(JSON.parse(readFileSync(new URL("site.json", dir), "utf8")));
  const weeks = readdirSync(new URL("weeks/", dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => SiteWeek.parse(JSON.parse(readFileSync(new URL(`weeks/${f}`, dir), "utf8"))));
  const files = buildSite(SiteConfig.parse({}), weeks, assets);
  for (const l of links(files)) assert.ok(files.has(l.to), `${l.from} links to ${l.to}`);
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

test("each step on the recipe page lists what goes in, with its amount", () => {
  const html = recipePage(config, week, 0);
  const brown = html.split('<li class="k-cook">')[1]!.split("</li></ul>")[0]!;
  assert.match(brown, /<b>2 tbsp<\/b> oil/);
  assert.match(brown, /<b>1400 g<\/b> chicken thigh fillets/);
});

test("a saved text recipe whose steps name no ingredients gets the ones its text mentions", () => {
  const saved = fromText({ name: "Chili", servings: 6, ingredients: "1 kg beef chuck, in 3 cm cubes\n3 yellow onions, chopped", method: "1. Brown the beef.\n2. Soften the onions." });
  for (const s of saved.steps) s.uses = [];
  const parsed = SiteWeek.parse({ pickup: "2026-10-30", dishes: [{ name: "Chili", portions: 6, recipe: saved, fromText: true }] });
  assert.deepEqual(cookData(config, parsed, 0).steps.map((s) => s.uses), [["<b>1 kg</b> beef chuck, in 3 cm cubes"], ["<b>3</b> yellow onions, chopped"]]);
});

test("an ingredient an earlier step worked on is named by that step, not given its amount again", () => {
  const uses = cookData(config, week, 0).steps.map((s) => s.uses);
  // The curry: the squash cubed in step 1 and the chicken browned in step 2 go in at step 4.
  assert.deepEqual(uses[3], ['butternut squash <span class="from">from step 1</span>', 'browned chicken <span class="from">from step 2</span>', '<b>2 cans</b> coconut milk <span class="home">at home</span>']);
  // The onion chopped in step 1 is fried in step 3; salt to taste has no amount to repeat.
  assert.ok(uses[2]!.includes('yellow onions <span class="from">from step 1</span>'));
  assert.deepEqual(uses[5]!.slice(1), ["salt"]);

  const text = fromText({ name: "Stir fry", servings: 4, ingredients: "2 packs firm tofu (400 g), in cubes\n900 g chicken breast, in strips", method: "1. Fry the tofu.\n2. Fry the chicken.\n3. Return the tofu and chicken." });
  const sv = cookData({ title: "Mat", language: "sv" }, { pickup: "2026-10-30", dishes: [{ name: "x", portions: 4, recipe: text, fromText: true }] }, 0);
  assert.deepEqual(sv.steps[2]!.uses, ['firm tofu <span class="from">från steg 1</span>', 'chicken breast <span class="from">från steg 2</span>']);
});
