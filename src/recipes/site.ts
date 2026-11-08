import { z } from "zod";
import { timeline } from "./check.ts";
import { mentioned } from "./legacy.ts";
import { amount, Recipe, type Ingredient, type Step } from "./recipe.ts";

// The public recipe site: an index of weeks, a page per week with its
// dishes, and for each dish the whole recipe and a cook mode that walks the
// steps with timers (site/cook.js). Pages are static HTML with relative
// links, so the same build works on a preview URL and on the real domain.
// The data is only what a recipe needs: no prices, shopping, members or
// reasons.

export const SiteWeek = z.object({
  pickup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dishes: z.array(
    z
      .object({
        name: z.string().min(1),
        portions: z.number().int().positive(),
        recipe: Recipe,
        // Read from a recipe saved as text, so its steps have only the
        // ingredients their text names and no hands-on times.
        fromText: z.boolean().default(false),
      })
      .transform((d) => (d.fromText ? { ...d, recipe: withMentioned(d.recipe) } : d)),
  ),
});
export type SiteWeek = z.output<typeof SiteWeek>;

// A text recipe whose steps name no ingredients gets the ones each step's
// text mentions, so its steps show what goes in and how much.
function withMentioned(r: Recipe): Recipe {
  if (r.steps.some((s) => s.uses.length)) return r;
  return { ...r, steps: r.steps.map((s) => ({ ...s, uses: mentioned(s.text, r.ingredients) })) };
}

export const SiteConfig = z.object({
  title: z.string().default("Food"),
  language: z.enum(["en", "sv"]).default("en"),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

export type Language = SiteConfig["language"];

export const STRINGS = {
  en: {
    week: "Week",
    dinners: ["No dinners", "One dinner", "Two dinners", "Three dinners", "Four dinners", "Five dinners", "Six dinners", "Seven dinners"],
    ordinals: ["Dinner one", "Dinner two", "Dinner three", "Dinner four", "Dinner five", "Dinner six", "Dinner seven"],
    portions: "portions",
    steps: "steps",
    portionsEach: "portions each",
    total: "Total",
    handsOn: "Hands-on",
    portionsLabel: "Portions",
    min: "min",
    ingredients: "Ingredients",
    gather: "Tap as you gather",
    equipment: "You need",
    method: "Method",
    notes: "Notes",
    cookAlong: "Cook along, step by step",
    allWeeks: "All weeks",
    noWeeks: "No weeks yet.",
    pantry: "at home",
    start: "Start cooking",
    back: "Back",
    nextStep: "Next step",
    next: "Next",
    done: "Done",
    recipe: "Recipe",
    beforeStart: "Before you start",
    stepOf: "Step {n} of {total}",
    startTimer: "Start {label} timer",
    timerRunning: "Timer running",
    timerDone: "Done!",
    nextTimer: "Next timer",
    waitsFor: "Waits for",
    whileRuns: "This runs on its own: start the timer and carry on.",
    runsOnItsOwn: "runs on its own",
    oven: "Oven",
    fan: "fan",
    heat: { low: "Low heat", medium: "Medium heat", high: "High heat" },
    kinds: { preheat: "Preheat", prep: "Prep", cook: "Cook", simmer: "Simmer", bake: "Oven", rest: "Rest", assemble: "Assemble", serve: "Serve" },
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    to: "to",
  },
  sv: {
    week: "Vecka",
    dinners: ["Inga middagar", "En middag", "Två middagar", "Tre middagar", "Fyra middagar", "Fem middagar", "Sex middagar", "Sju middagar"],
    ordinals: ["Middag ett", "Middag två", "Middag tre", "Middag fyra", "Middag fem", "Middag sex", "Middag sju"],
    portions: "portioner",
    steps: "steg",
    portionsEach: "portioner var",
    total: "Totalt",
    handsOn: "Aktiv tid",
    portionsLabel: "Portioner",
    min: "min",
    ingredients: "Ingredienser",
    gather: "Bocka av när du plockar fram",
    equipment: "Du behöver",
    method: "Gör så här",
    notes: "Tips",
    cookAlong: "Laga steg för steg",
    allWeeks: "Alla veckor",
    noWeeks: "Inga veckor än.",
    pantry: "finns hemma",
    start: "Börja laga",
    back: "Bakåt",
    nextStep: "Nästa steg",
    next: "Nästa",
    done: "Klar",
    recipe: "Recept",
    beforeStart: "Innan du börjar",
    stepOf: "Steg {n} av {total}",
    startTimer: "Starta timer: {label}",
    timerRunning: "Timern går",
    timerDone: "Klart!",
    nextTimer: "Nästa timer",
    waitsFor: "Väntar på",
    whileRuns: "Det här sköter sig självt: starta timern och fortsätt.",
    runsOnItsOwn: "sköter sig självt",
    oven: "Ugn",
    fan: "varmluft",
    heat: { low: "Låg värme", medium: "Medelvärme", high: "Hög värme" },
    kinds: { preheat: "Sätt på ugnen", prep: "Förbered", cook: "Laga", simmer: "Låt koka", bake: "Ugn", rest: "Vila", assemble: "Sätt ihop", serve: "Servera" },
    days: ["sön", "mån", "tis", "ons", "tor", "fre", "lör"],
    months: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    to: "till",
  },
} as const;

const FONTS = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Instrument+Sans:wght@400;500;600&display=swap";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "recipe";
}

// Each dish's path segment in a week, unique within the week.
export function dishSlugs(week: SiteWeek): string[] {
  const used = new Set<string>();
  return week.dishes.map((d) => {
    let s = slug(d.name);
    for (let n = 2; used.has(s); n++) s = `${slug(d.name)}-${n}`;
    used.add(s);
    return s;
  });
}

// ISO 8601 week number of a date.
export function isoWeek(date: string): number {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

// "Week 44".
export function weekName(pickup: string, lang: Language): string {
  return `${STRINGS[lang].week} ${isoWeek(pickup)}`;
}

// "Fri 30 Oct to Thu 5 Nov": the pickup and the week of food it is for, up
// to the day before the next pickup.
export function weekRange(pickup: string, lang: Language): string {
  const t = STRINGS[lang];
  const d = new Date(`${pickup}T12:00:00Z`);
  const end = new Date(d.getTime() + 6 * 86400000);
  const fmt = (x: Date) => `${t.days[x.getUTCDay()]} ${x.getUTCDate()} ${t.months[x.getUTCMonth()]}`;
  return `${fmt(d)} ${t.to} ${fmt(end)}`;
}

function minutes(n: number, lang: Language): string {
  const t = STRINGS[lang];
  if (n < 60) return `${Math.round(n)} ${t.min}`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h} h ${m} ${t.min}` : `${h} h`;
}

// The colour class of the i-th dish in a week.
const dishClass = (i: number) => `d-${i % 4}`;

// An ingredient as one line, for cook mode: "<b>1400 g</b> chicken, in
// pieces".
export function ingredientLine(i: Ingredient, lang: Language, qty = i.qty): string {
  const a = amount(qty, i.unit);
  const pantry = i.fromPantry ? ` <span class="home">${esc(STRINGS[lang].pantry)}</span>` : "";
  return `${a ? `<b>${esc(a)}</b> ` : ""}${esc(i.name)}${i.prep ? `<span class="prep">, ${esc(i.prep)}</span>` : ""}${pantry}`;
}

function timerText(s: Step, lang: Language): string {
  if (!s.timer) return "";
  const t = STRINGS[lang];
  const { minutes: from, upTo } = s.timer;
  if (!upTo) return minutes(from, lang);
  return from < 60 && upTo < 60 ? `${from} ${t.to} ${upTo} ${t.min}` : `${minutes(from, lang)} ${t.to} ${minutes(upTo, lang)}`;
}

function chips(s: Step, lang: Language): string[] {
  const t = STRINGS[lang];
  return [s.oven ? `${t.oven} ${s.oven.celsius}°C${s.oven.fan ? `, ${t.fan}` : ""}` : "", s.heat ? t.heat[s.heat] : ""].filter(Boolean);
}

function layout(o: { title: string; lang: Language; root: string; body: string; bodyClass?: string; script?: string }): string {
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#c8442b">
<title>${esc(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${o.root}style.css">
</head>
<body${o.bodyClass ? ` class="${o.bodyClass}"` : ""}>
${o.body}
${o.script ?? ""}
</body>
</html>
`;
}

export function indexPage(config: SiteConfig, weeks: SiteWeek[]): string {
  const lang = config.language;
  const t = STRINGS[lang];
  const sorted = [...weeks].sort((a, b) => b.pickup.localeCompare(a.pickup));
  const items = sorted
    .map((w) => {
      const dishes = w.dishes.map((d, i) => `<li class="${dishClass(i)}">${esc(d.name)}</li>`).join("");
      return `<a class="week-link" href="${w.pickup}/"><div class="kicker" style="color:var(--tomato)">${esc(weekName(w.pickup, lang))}</div><div class="range">${esc(weekRange(w.pickup, lang))}</div><ul>${dishes}</ul></a>`;
    })
    .join("\n");
  return layout({
    title: config.title,
    lang,
    root: "",
    body: `<header class="band"><div class="wrap"><div class="kicker">${esc(t.allWeeks)}</div><h1>${esc(config.title)}</h1></div></header>
<main class="wrap">${items ? `<div class="weeks">${items}</div>` : `<p class="empty">${esc(t.noWeeks)}</p>`}</main>`,
  });
}

export function weekPage(config: SiteConfig, week: SiteWeek): string {
  const lang = config.language;
  const t = STRINGS[lang];
  const slugs = dishSlugs(week);
  const portions = new Set(week.dishes.map((d) => d.portions));
  const cards = week.dishes
    .map((d, i) => {
      const tl = d.fromText ? null : timeline(d.recipe);
      const facts = [
        tl ? minutes(tl.totalMinutes, lang) : `${d.recipe.steps.length} ${t.steps}`,
        tl ? `${minutes(tl.activeMinutes, lang)} ${t.handsOn.toLowerCase()}` : "",
        portions.size > 1 ? `${d.portions} ${t.portions}` : "",
      ].filter(Boolean);
      return `<a class="dish-card ${dishClass(i)}" href="${slugs[i]}/"><div class="no">${i + 1}</div><div><h2>${esc(d.name)}</h2>${d.recipe.summary ? `<p>${esc(d.recipe.summary)}</p>` : ""}
${facts.length ? `<div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
<div class="kinds">${d.recipe.steps.map((s) => `<i class="k-${s.kind}"></i>`).join("")}</div></div></a>`;
    })
    .join("\n");
  const count = t.dinners[week.dishes.length] ?? `${week.dishes.length}`;
  return layout({
    title: `${weekName(week.pickup, lang)} · ${config.title}`,
    lang,
    root: "../",
    body: `<header class="band"><div class="wrap"><a class="back" href="../">← ${esc(t.allWeeks)}</a>
<div class="kicker" style="margin-top:18px">${esc(weekName(week.pickup, lang))}</div><h1>${esc(count)}</h1><div class="range">${esc(weekRange(week.pickup, lang))}</div>
${portions.size === 1 ? `<div class="meta">${[...portions][0]} ${esc(t.portionsEach)}</div>` : ""}</div></header>
<main class="wrap"><div class="dishes">${cards}</div></main>`,
  });
}

export function recipePage(config: SiteConfig, week: SiteWeek, index: number): string {
  const lang = config.language;
  const t = STRINGS[lang];
  const d = week.dishes[index]!;
  const r = d.recipe;
  const tl = d.fromText ? null : timeline(r);
  const groups = new Map<string, Ingredient[]>();
  for (const i of r.ingredients) groups.set(i.group ?? "", [...(groups.get(i.group ?? "") ?? []), i]);
  const amounts = r.ingredients.some((i) => i.qty !== undefined);
  const ingredients = [...groups]
    .map(
      ([g, list]) =>
        `${g ? `<h4>${esc(g)}</h4>` : ""}<ul class="ing${amounts ? "" : " no-amounts"}">${list
          .map((i) => {
            const a = amount(i.qty, i.unit);
            return `<li><label><input type="checkbox">${amounts ? `<span class="amt">${esc(a)}</span>` : ""}<span><span class="n">${esc(i.name)}</span>${i.prep ? `<span class="prep">, ${esc(i.prep)}</span>` : ""}${i.fromPantry ? `<span class="home">${esc(t.pantry)}</span>` : ""}</span></label></li>`;
          })
          .join("")}</ul>`,
    )
    .join("");
  const byId = new Map(r.ingredients.map((i) => [i.id, i]));
  const steps = r.steps
    .map((s, i) => {
      const uses = s.uses.flatMap((u) => {
        const ing = byId.get(u.ingredient);
        return ing ? [`<li><span>${ingredientLine(ing, lang, u.qty ?? ing.qty)}</span></li>`] : [];
      });
      const extra = chips(s, lang);
      const tag = s.timer ? `<span class="tag">${esc(timerText(s, lang))}${s.passive ? `, ${esc(t.runsOnItsOwn)}` : ""}</span>` : "";
      return `<li class="k-${s.kind}"><div class="num">${i + 1}</div><div><div class="kind">${esc(t.kinds[s.kind])}${extra.length ? ` <span>· ${esc(extra.join(" · "))}</span>` : ""}</div><p>${esc(s.text)}</p>${uses.length ? `<ul class="uses">${uses.join("")}</ul>` : ""}${tag}</div></li>`;
    })
    .join("");
  const stats = [
    tl ? `<div class="k-cook"><b>${tl.totalMinutes}<small> ${esc(t.min)}</small></b><span>${esc(t.total)}</span></div>` : "",
    tl ? `<div class="k-prep"><b>${tl.activeMinutes}<small> ${esc(t.min)}</small></b><span>${esc(t.handsOn)}</span></div>` : "",
    `<div class="k-serve"><b>${d.portions}</b><span>${esc(t.portionsLabel)}</span></div>`,
  ].join("");
  return layout({
    title: `${d.name} · ${config.title}`,
    lang,
    root: "../../",
    body: `<header class="band dish ${dishClass(index)}"><div class="wrap"><a class="back" href="../">← ${esc(weekName(week.pickup, lang))}</a>
<div class="kicker" style="margin-top:20px">${esc(t.ordinals[index] ?? "")}</div><h1>${esc(d.name)}</h1>${r.summary ? `<p class="lede">${esc(r.summary)}</p>` : ""}</div></header>
<main class="wrap recipe"><aside><div class="stats">${stats}</div>
<a class="cta" href="cook/">${esc(t.cookAlong)} <i>→</i></a>
${r.equipment.length ? `<h4>${esc(t.equipment)}</h4><p class="equipment">${esc(r.equipment.join(", "))}</p>` : ""}
<h3 id="ingredients">${esc(t.ingredients)} <small>${esc(t.gather)}</small></h3>${ingredients}</aside>
<div class="method-col"><h3>${esc(t.method)}</h3><ol class="method">${steps}</ol>
${r.notes ? `<div class="notes">${esc(r.notes)}</div>` : ""}</div></main>`,
  });
}

// What cook mode needs, embedded in its page: the recipe with each step's
// ingredients and labels spelled out, and the interface strings.
export function cookData(config: SiteConfig, week: SiteWeek, index: number) {
  const lang = config.language;
  const t = STRINGS[lang];
  const d = week.dishes[index]!;
  const r = d.recipe;
  const byId = new Map(r.ingredients.map((i) => [i.id, i]));
  return {
    key: `${week.pickup}/${dishSlugs(week)[index]}`,
    name: d.name,
    fromText: d.fromText,
    equipment: r.equipment,
    ingredients: r.ingredients.map((i) => ingredientLine(i, lang)),
    steps: r.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      text: s.text,
      uses: s.uses.flatMap((u) => {
        const i = byId.get(u.ingredient);
        return i ? [ingredientLine(i, lang, u.qty ?? i.qty)] : [];
      }),
      timer: s.timer ?? null,
      timerText: timerText(s, lang),
      startLabel: s.timer ? t.startTimer.replace("{label}", lang === "en" ? s.timer.label.toLowerCase() : s.timer.label) : "",
      passive: s.passive ?? false,
      after: s.after ?? [],
      chips: chips(s, lang),
    })),
    t: {
      min: t.min, done: t.done, start: t.start, next: t.next, nextStep: t.nextStep, beforeStart: t.beforeStart, stepOf: t.stepOf,
      equipment: t.equipment, ingredients: t.ingredients, timerRunning: t.timerRunning, timerDone: t.timerDone, nextTimer: t.nextTimer,
      waitsFor: t.waitsFor, whileRuns: t.whileRuns, kinds: t.kinds,
    },
  };
}
export type CookData = ReturnType<typeof cookData>;

export function cookPage(config: SiteConfig, week: SiteWeek, index: number): string {
  const d = week.dishes[index]!;
  const t = STRINGS[config.language];
  // </script> cannot appear inside the JSON: every < is escaped.
  const data = JSON.stringify(cookData(config, week, index)).replace(/</g, "\\u003c");
  return layout({
    title: d.name,
    lang: config.language,
    root: "../../../",
    bodyClass: "cook",
    body: `<div id="app">
<header id="top" class="cook-top k-cook"><div class="wrap"><div class="bar"><a class="x" href="../" aria-label="${esc(t.back)}">×</a><span class="title">${esc(d.name)}</span><strong id="count">${esc(t.beforeStart)}</strong><a href="../#ingredients">${esc(t.recipe)}</a></div>
<div class="progress" id="progress"></div><div class="timers" id="timers" aria-live="polite"></div></div></header>
<main id="body" class="cook-body"><div id="step" class="wrap"><noscript><a href="../">${esc(d.name)}</a></noscript></div></main>
<footer class="cook-foot"><div class="wrap"><div id="go"></div><div class="nav"><button id="prev" data-act="prev" disabled>${esc(t.back)}</button><button id="next" class="next" data-act="next">${esc(t.start)}</button></div></div></footer>
</div>`,
    script: `<script type="application/json" id="data">${data}</script>\n<script src="../../../cook.js"></script>`,
  });
}

// Every file of the site, by path.
export function buildSite(config: SiteConfig, weeks: SiteWeek[], assets: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>(Object.entries(assets));
  files.set("index.html", indexPage(config, weeks));
  for (const w of weeks) {
    files.set(`${w.pickup}/index.html`, weekPage(config, w));
    dishSlugs(w).forEach((s, i) => {
      files.set(`${w.pickup}/${s}/index.html`, recipePage(config, w, i));
      files.set(`${w.pickup}/${s}/cook/index.html`, cookPage(config, w, i));
    });
  }
  return files;
}
