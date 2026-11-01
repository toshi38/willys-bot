import { z } from "zod";
import { timeline } from "./check.ts";
import { amount, Recipe, type Ingredient, type Step } from "./recipe.ts";

// The public recipe site: an index of weeks, a page per week with its
// dishes, and for each dish the whole recipe and a cook mode that walks the
// steps with timers. Pages are static HTML with relative links, so the same
// build works on a preview URL and on the real domain. The data is only
// what a recipe needs: no prices, shopping, members or reasons.

export const SiteWeek = z.object({
  pickup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dishes: z.array(
    z.object({
      name: z.string().min(1),
      portions: z.number().int().positive(),
      recipe: Recipe,
      // Read from a recipe saved as text, so its steps carry no
      // ingredients and cook mode lists them all first.
      fromText: z.boolean().default(false),
    }),
  ),
});
export type SiteWeek = z.infer<typeof SiteWeek>;

export const SiteConfig = z.object({
  title: z.string().default("Recipes"),
  language: z.enum(["en", "sv"]).default("en"),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

export type Language = SiteConfig["language"];

export const STRINGS = {
  en: {
    week: "W",
    portions: "portions",
    serves: "Serves",
    ready: "Ready in about",
    handsOn: "hands-on",
    min: "min",
    ingredients: "Ingredients",
    equipment: "You need",
    method: "Method",
    notes: "Notes",
    cook: "Start cooking",
    allWeeks: "All weeks",
    noWeeks: "No weeks yet.",
    pantry: "at home",
    start: "Start",
    back: "Back",
    next: "Next",
    done: "Done",
    beforeStart: "Before you start",
    timerStart: "Start timer",
    timerGoOn: "Start timer and carry on",
    timerRunning: "Timer running",
    timerDone: "Done!",
    waitsFor: "Waits for",
    whileRuns: "This runs on its own: carry on with the next step.",
    upTo: "up to",
    step: "Step",
    oven: "Oven",
    fan: "fan",
    heat: { low: "Low heat", medium: "Medium heat", high: "High heat" },
    kinds: { preheat: "Preheat", prep: "Prep", cook: "Cook", simmer: "Simmer", bake: "Oven", rest: "Rest", assemble: "Assemble", serve: "Serve" },
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    to: "to",
  },
  sv: {
    week: "V",
    portions: "portioner",
    serves: "Portioner",
    ready: "Klart på ungefär",
    handsOn: "aktiv tid",
    min: "min",
    ingredients: "Ingredienser",
    equipment: "Du behöver",
    method: "Gör så här",
    notes: "Tips",
    cook: "Börja laga",
    allWeeks: "Alla veckor",
    noWeeks: "Inga veckor än.",
    pantry: "finns hemma",
    start: "Börja",
    back: "Bakåt",
    next: "Nästa",
    done: "Klar",
    beforeStart: "Innan du börjar",
    timerStart: "Starta timer",
    timerGoOn: "Starta timer och fortsätt",
    timerRunning: "Timern går",
    timerDone: "Klart!",
    waitsFor: "Väntar på",
    whileRuns: "Det här sköter sig självt: fortsätt med nästa steg.",
    upTo: "upp till",
    step: "Steg",
    oven: "Ugn",
    fan: "varmluft",
    heat: { low: "Låg värme", medium: "Medelvärme", high: "Hög värme" },
    kinds: { preheat: "Sätt på ugnen", prep: "Förbered", cook: "Laga", simmer: "Låt koka", bake: "Ugn", rest: "Vila", assemble: "Sätt ihop", serve: "Servera" },
    days: ["sön", "mån", "tis", "ons", "tor", "fre", "lör"],
    months: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    to: "till",
  },
} as const;

export const KIND_ICONS: Record<Step["kind"], string> = { preheat: "🌡️", prep: "🔪", cook: "🍳", simmer: "🍲", bake: "🔥", rest: "⏸️", assemble: "🧩", serve: "🍽️" };

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

// "W44 · Fri 30 Oct to Thu 5 Nov": the pickup and the week of food it is
// for, up to the day before the next pickup.
export function weekLabel(pickup: string, lang: Language): string {
  const t = STRINGS[lang];
  const d = new Date(`${pickup}T12:00:00Z`);
  const end = new Date(d.getTime() + 6 * 86400000);
  const fmt = (x: Date) => `${t.days[x.getUTCDay()]} ${x.getUTCDate()} ${t.months[x.getUTCMonth()]}`;
  return `${t.week}${isoWeek(pickup)} · ${fmt(d)} ${t.to} ${fmt(end)}`;
}

function minutes(n: number, lang: Language): string {
  const t = STRINGS[lang];
  if (n < 60) return `${Math.round(n)} ${t.min}`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h} h ${m} ${t.min}` : `${h} h`;
}

export function ingredientLine(i: Ingredient, lang: Language, qty = i.qty): string {
  const a = amount(qty, i.unit);
  const pantry = i.fromPantry ? ` <span class="pantry">${esc(STRINGS[lang].pantry)}</span>` : "";
  return `${a ? `<b>${esc(a)}</b> ` : ""}${esc(i.name)}${i.prep ? `<span class="prep">, ${esc(i.prep)}</span>` : ""}${pantry}`;
}

function timerText(s: Step, lang: Language): string {
  if (!s.timer) return "";
  const t = STRINGS[lang];
  return s.timer.upTo ? `${s.timer.minutes} ${t.to} ${s.timer.upTo} ${t.min}` : `${s.timer.minutes} ${t.min}`;
}

function layout(o: { title: string; lang: Language; root: string; body: string; bodyClass?: string; script?: string }): string {
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#faf8f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171614" media="(prefers-color-scheme: dark)">
<title>${esc(o.title)}</title>
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
  const sorted = [...weeks].sort((a, b) => b.pickup.localeCompare(a.pickup));
  const items = sorted
    .map((w) => {
      const slugs = dishSlugs(w);
      const dishes = w.dishes.map((d, i) => `<li><a href="${w.pickup}/${slugs[i]}/">${esc(d.name)}</a></li>`).join("");
      return `<section class="week"><h2><a href="${w.pickup}/">${esc(weekLabel(w.pickup, lang))}</a></h2><ul class="dishes">${dishes}</ul></section>`;
    })
    .join("\n");
  return layout({ title: config.title, lang, root: "", body: `<main><h1>${esc(config.title)}</h1>${items || `<p class="muted">${esc(STRINGS[lang].noWeeks)}</p>`}</main>` });
}

export function weekPage(config: SiteConfig, week: SiteWeek): string {
  const lang = config.language;
  const t = STRINGS[lang];
  const slugs = dishSlugs(week);
  const cards = week.dishes
    .map((d, i) => {
      const tl = d.fromText ? null : timeline(d.recipe);
      const meta = [`${d.portions} ${t.portions}`, tl ? `${t.ready} ${minutes(tl.totalMinutes, lang)}` : ""].filter(Boolean).join(" · ");
      return `<a class="dish-card" href="${slugs[i]}/"><strong>${esc(d.name)}</strong>${d.recipe.summary ? `<span>${esc(d.recipe.summary)}</span>` : ""}<span class="muted">${esc(meta)}</span></a>`;
    })
    .join("\n");
  const label = weekLabel(week.pickup, lang);
  return layout({
    title: `${label} · ${config.title}`,
    lang,
    root: "../",
    body: `<main><nav class="crumbs"><a href="../">${esc(t.allWeeks)}</a></nav><h1>${esc(label)}</h1>${cards}</main>`,
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
  const ingredients = [...groups]
    .map(([g, list]) => `${g ? `<h3>${esc(g)}</h3>` : ""}<ul class="check">${list.map((i) => `<li><label><input type="checkbox"><span>${ingredientLine(i, lang)}</span></label></li>`).join("")}</ul>`)
    .join("");
  const steps = r.steps
    .map((s) => {
      const chips = [
        s.timer ? `<span class="chip timer">⏱ ${esc(timerText(s, lang))}</span>` : "",
        s.oven ? `<span class="chip">${esc(`${t.oven} ${s.oven.celsius}°C${s.oven.fan ? `, ${t.fan}` : ""}`)}</span>` : "",
        s.heat ? `<span class="chip">${esc(t.heat[s.heat])}</span>` : "",
      ].join("");
      return `<li class="kind-${s.kind}"><span class="kind">${KIND_ICONS[s.kind]} ${esc(t.kinds[s.kind])}</span><p>${esc(s.text)}</p>${chips ? `<div class="chips">${chips}</div>` : ""}</li>`;
    })
    .join("");
  const facts = [
    `${t.serves} ${d.portions}`,
    tl ? `${t.ready} ${minutes(tl.totalMinutes, lang)} (${minutes(tl.activeMinutes, lang)} ${t.handsOn})` : "",
  ].filter(Boolean);
  const label = weekLabel(week.pickup, lang);
  return layout({
    title: `${d.name} · ${config.title}`,
    lang,
    root: "../../",
    body: `<main class="recipe">
<nav class="crumbs"><a href="../../">${esc(t.allWeeks)}</a> › <a href="../">${esc(label)}</a></nav>
<h1>${esc(d.name)}</h1>
${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}
<p class="facts">${facts.map(esc).join(" · ")}</p>
<a class="button primary" href="cook/">${KIND_ICONS.cook} ${esc(t.cook)}</a>
${r.equipment.length ? `<h2>${esc(t.equipment)}</h2><p>${esc(r.equipment.join(", "))}</p>` : ""}
<h2>${esc(t.ingredients)}</h2>${ingredients}
<h2>${esc(t.method)}</h2><ol class="steps">${steps}</ol>
${r.notes ? `<h2>${esc(t.notes)}</h2><p class="notes">${esc(r.notes)}</p>` : ""}
</main>`,
    script: `<script>document.querySelectorAll('.check input').forEach(function(c){c.addEventListener('change',function(){c.closest('li').classList.toggle('got',c.checked)})})</script>`,
  });
}

// What cook mode needs, embedded in its page: the recipe with each step's
// ingredients spelled out, and the interface strings.
export function cookData(config: SiteConfig, week: SiteWeek, index: number) {
  const lang = config.language;
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
      icon: KIND_ICONS[s.kind],
      text: s.text,
      uses: s.uses.flatMap((u) => {
        const i = byId.get(u.ingredient);
        return i ? [ingredientLine(i, lang, u.qty ?? i.qty)] : [];
      }),
      timer: s.timer ?? null,
      timerText: timerText(s, lang),
      passive: s.passive ?? false,
      after: s.after ?? [],
      chips: [s.oven ? `${STRINGS[lang].oven} ${s.oven.celsius}°C${s.oven.fan ? `, ${STRINGS[lang].fan}` : ""}` : "", s.heat ? STRINGS[lang].heat[s.heat] : ""].filter(Boolean),
    })),
    t: STRINGS[lang],
  };
}

export function cookPage(config: SiteConfig, week: SiteWeek, index: number): string {
  const d = week.dishes[index]!;
  const t = STRINGS[config.language];
  // </script> cannot appear inside the JSON: every < is escaped.
  const data = JSON.stringify(cookData(config, week, index)).replace(/</g, "\\u003c");
  return layout({
    title: `${d.name} · ${t.cook}`,
    lang: config.language,
    root: "../../../",
    bodyClass: "cook",
    body: `<div id="app"><header class="cook-bar"><a class="close" href="../" aria-label="${esc(t.back)}">✕</a><strong>${esc(d.name)}</strong><span id="count"></span></header>
<div id="timers" class="timers" aria-live="polite"></div>
<main id="card" class="card-area"></main>
<footer class="cook-nav"><button id="prev" class="button">${esc(t.back)}</button><button id="next" class="button primary">${esc(t.next)}</button></footer></div>
<noscript><p>${esc(t.method)}: <a href="../">${esc(d.name)}</a></p></noscript>`,
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
