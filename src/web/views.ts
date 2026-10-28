import type { Household } from "../core/household.ts";
import type { Dish, ListItem, PantryItem, PriceObservation, Recipe, Week, WeekItem } from "../core/store.ts";

// Server-rendered HTML for the web UI. Every value from the database or a
// request goes through esc(); the only markup is built here.

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const kr = (n: number) => `${n.toFixed(2).replace(/\.00$/, "").replace(".", ",")} kr`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" }) : "");

const CSS = `
:root { --bg: #faf8f5; --fg: #1f1d1a; --muted: #6b665e; --card: #fff; --line: #e6e1d9; --accent: #c8102e; --ok: #2f7d32; --warn: #b26a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #171614; --fg: #ece8e1; --muted: #a39d93; --card: #211f1c; --line: #34312c; --accent: #ff5a6e; --ok: #6fbf73; --warn: #f0a640; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
header strong { margin-right: 8px; }
header a { color: var(--fg); text-decoration: none; }
header a.on { color: var(--accent); font-weight: 600; }
header .who { margin-left: auto; color: var(--muted); font-size: 14px; }
main { max-width: 860px; margin: 0 auto; padding: 16px; }
h1 { font-size: 22px; margin: 8px 0 16px; }
h2 { font-size: 17px; margin: 24px 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.muted { color: var(--muted); font-size: 14px; }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 13px; border: 1px solid var(--line); }
.s-sent, .s-low { color: var(--warn); border-color: var(--warn); }
.s-applied, .s-approved, .s-have { color: var(--ok); border-color: var(--ok); }
.s-rejected, .s-failed, .s-out { color: var(--accent); border-color: var(--accent); }
form.inline { display: inline; }
input, select, textarea, button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
textarea { width: 100%; min-height: 70px; }
button { cursor: pointer; background: var(--card); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row input[type=text] { flex: 1 1 160px; min-width: 0; }
a { color: var(--accent); }
.flash { border-left: 4px solid var(--warn); }
svg { width: 100%; height: 120px; }
@media (max-width: 600px) { .hide-sm { display: none; } }
`;

export interface PageOpts {
  household: Household;
  member: string;
  active: string;
  flash?: string | null;
}

export function page(opts: PageOpts, title: string, body: string): string {
  const nav = [
    ["/", "Home"],
    ["/plans", "Plans"],
    ["/list", "List"],
    ["/pantry", "Pantry"],
    ["/offers", "Offers"],
  ]
    .map(([href, label]) => `<a href="${href}" class="${opts.active === href ? "on" : ""}">${label}</a>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · food-bot</title><style>${CSS}</style></head><body>
<header><strong>food-bot</strong>${nav}<span class="who">${esc(opts.household.config.name)} · ${esc(opts.member)}</span></header>
<main>${opts.flash ? `<div class="card flash">${esc(opts.flash)}</div>` : ""}${body}</main></body></html>`;
}

const badge = (status: string) => `<span class="badge s-${esc(status)}">${esc(status)}</span>`;

// A week with what its pages show.
export interface WeekView {
  week: Week;
  dishes: Dish[];
  items: WeekItem[];
  recipes: Map<number, Recipe>;
}

const total = (items: WeekItem[]) => items.reduce((s, i) => s + i.qty * (i.unitPrice ?? 0), 0);
const sourceLabel = (i: WeekItem, dishes: Dish[]) =>
  i.source === "request" ? `asked for${i.requestedBy ? ` by ${i.requestedBy}` : ""}` : i.source === "dish" ? (dishes.find((d) => d.id === i.dishId)?.name ?? "dish") : "basic or restock";

export function weekSummaryRow(v: WeekView): string {
  return `<tr><td><a href="/plans/${esc(v.week.id)}">${esc(v.week.id)}</a></td><td>${badge(v.week.status)}</td>
<td>${v.dishes.map((d) => esc(d.name)).join("<br>")}</td><td class="num hide-sm">${kr(total(v.items))}</td></tr>`;
}

export function weeksTable(weeks: WeekView[]): string {
  if (!weeks.length) return `<p class="muted">No weeks yet.</p>`;
  return `<table><tr><th>Pickup</th><th>Status</th><th>Dishes</th><th class="num hide-sm">Estimate</th></tr>${weeks.map(weekSummaryRow).join("")}</table>`;
}

export function weekDetail(v: WeekView, busy: boolean): string {
  const { week: w, dishes, items } = v;
  const decision =
    w.status === "open"
      ? busy
        ? `<p class="muted">Working on it: refresh in a minute.</p>`
        : `<div class="card"><h2 style="margin-top:0">Your decision</h2>
<div class="row"><form method="post" action="/plans/${esc(w.id)}/approve" class="inline"><button class="primary">Approve: fill the cart and book a slot</button></form>
<form method="post" action="/plans/${esc(w.id)}/reject" class="inline"><button>Skip this week</button></form></div>
<form method="post" action="/plans/${esc(w.id)}/change"><h2>Or ask for a change</h2><textarea name="feedback" required placeholder="2 skyr instead of 1, swap the stir-fry for a curry"></textarea><p><button>Make the change</button></p><p class="muted">Only what you ask for changes; the rest stays.</p></form></div>`
      : "";
  return `<h1>Pickup ${esc(w.id)} ${badge(w.status)}</h1>
<p class="muted">Drafted ${esc(day(w.createdAt))}${w.decidedBy ? `. Decided by ${esc(w.decidedBy)} ${esc(day(w.decidedAt))}` : ""}${w.appliedAt ? `. Cart filled ${esc(day(w.appliedAt))}` : ""}</p>
${w.error ? `<div class="card flash"><strong>Error:</strong> ${esc(w.error)}</div>` : ""}
${decision}
<div class="card"><p>${esc(w.summary)}</p></div>
<h2>Dishes</h2>
${dishes
  .map((d) => {
    const r = d.recipeId ? v.recipes.get(d.recipeId) : undefined;
    const recipe = r
      ? `<details><summary>Recipe</summary><ul>${r.ingredients.split("\n").filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p style="white-space:pre-line">${esc(r.method)}</p></details>`
      : "";
    return `<div class="card"><strong>${esc(d.name)}</strong> <span class="muted">${esc(d.portions)} portions</span><br>${esc(d.why)}${recipe}</div>`;
  })
  .join("")}
<h2>Shopping, about ${kr(total(items))}</h2>
<table><tr><th>Qty</th><th>Product</th><th class="num">Price</th><th class="hide-sm">For</th></tr>
${items.map((i) => `<tr><td>${esc(i.qty)}</td><td><a href="/product/${esc(encodeURIComponent(i.productCode))}">${esc(i.name ?? i.productCode)}</a></td><td class="num">${i.unitPrice === null ? "" : kr(i.unitPrice)}</td><td class="hide-sm muted">${esc(sourceLabel(i, dishes))}${i.reason ? `: ${esc(i.reason)}` : ""}</td></tr>`).join("")}
</table>
${w.notes ? `<h2>Notes</h2><div class="card" style="white-space:pre-line">${esc(w.notes)}</div>` : ""}`;
}

export function listPage(items: ListItem[], productName: (code: string) => string | null): string {
  return `<h1>Shopping list</h1>
<form method="post" action="/list/add" class="card row">
<input type="text" name="text" required placeholder="What do we need?" autofocus>
<input type="text" name="quantity" placeholder="How much" style="flex:0 1 120px">
<input type="text" name="note" placeholder="Note" style="flex:0 1 160px">
<button class="primary">Add</button></form>
${
  items.length
    ? `<table><tr><th>Item</th><th class="hide-sm">Added by</th><th></th></tr>${items
        .map(
          (i) => `<tr><td>${esc(i.text)}${i.quantity ? ` × ${esc(i.quantity)}` : ""}${i.note ? ` <span class="muted">(${esc(i.note)})</span>` : ""}${
            i.productCode ? `<br><span class="muted">${esc(productName(i.productCode) ?? i.productCode)}</span>` : ""
          }</td><td class="hide-sm muted">${esc(i.addedBy)}</td>
<td class="num"><form method="post" action="/list/${esc(i.id)}/remove" class="inline"><button>Remove</button></form></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">The list is empty. Items added here go into the next weekly shop.</p>`
}`;
}

export function pantryPage(items: PantryItem[]): string {
  const select = (name: string, current: string) =>
    `<select name="status" onchange="this.form.submit()">${["have", "low", "out"].map((s) => `<option${s === current ? " selected" : ""}>${s}</option>`).join("")}</select>`;
  return `<h1>Pantry</h1>
<p class="muted">What we keep at home. The planner never buys what is marked "have", and restocks "low" and "out" when needed.</p>
<form method="post" action="/pantry/set" class="card row">
<input type="text" name="name" required placeholder="Jasmine rice, cumin, Mrs Chang soy...">
<input type="text" name="quantity" placeholder="How much" style="flex:0 1 120px">
${select("new", "have")}<button class="primary">Save</button></form>
${
  items.length
    ? `<table><tr><th>Item</th><th>Status</th><th></th></tr>${items
        .map(
          (i) => `<tr><td>${esc(i.name)}${i.quantity ? ` <span class="muted">${esc(i.quantity)}</span>` : ""}${i.note ? `<br><span class="muted">${esc(i.note)}</span>` : ""}</td>
<td><form method="post" action="/pantry/set" class="inline"><input type="hidden" name="name" value="${esc(i.name)}">${select(i.name, i.status)}<noscript><button>Save</button></noscript></form></td>
<td class="num"><form method="post" action="/pantry/remove" class="inline"><input type="hidden" name="name" value="${esc(i.name)}"><button>Remove</button></form></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">Nothing recorded yet.</p>`
}`;
}

export function offersPage(q: string, offers: Array<{ code: string; name: string; volume: string | null; price: number; regular: number | null; label: string | null }>): string {
  return `<h1>This week's online offers</h1>
<form method="get" action="/offers" class="card row"><input type="text" name="q" value="${esc(q)}" placeholder="Filter: kyckling, kaffe, Garant..."><button>Filter</button></form>
<table><tr><th>Product</th><th class="num">Offer</th><th class="num hide-sm">Regular</th><th class="hide-sm">Deal</th></tr>
${offers
  .map(
    (o) => `<tr><td><a href="/product/${esc(encodeURIComponent(o.code))}">${esc(o.name)}</a> <span class="muted">${esc(o.volume ?? "")}</span></td>
<td class="num">${kr(o.price)}</td><td class="num hide-sm muted">${o.regular !== null ? kr(o.regular) : ""}</td><td class="hide-sm muted">${esc(o.label ?? "")}</td></tr>`,
  )
  .join("")}</table>
${offers.length ? "" : `<p class="muted">No offers recorded. The daily snapshot fills this.</p>`}`;
}

export function productPage(code: string, name: string | null, history: PriceObservation[]): string {
  const days = [...new Set(history.map((h) => h.observedOn))].sort();
  const series = (kind: string) => days.map((d) => history.find((h) => h.observedOn === d && h.kind === kind)?.price ?? null);
  const all = history.map((h) => h.price);
  const chart =
    days.length > 1
      ? sparkline(days, [
          { label: "Regular", color: "var(--muted)", values: series("regular") },
          { label: "Online offer", color: "var(--accent)", values: series("online-promo") },
          { label: "In-store offer", color: "var(--warn)", values: series("offline-promo") },
        ], Math.min(...all), Math.max(...all))
      : `<p class="muted">The chart appears once there are two days of prices.</p>`;
  return `<h1>${esc(name ?? code)}</h1><p class="muted">${esc(code)}</p>
<div class="card">${chart}</div>
<table><tr><th>Day</th><th>Kind</th><th class="num">Price</th><th class="hide-sm">Label</th></tr>
${[...history].reverse().map((h) => `<tr><td>${esc(h.observedOn)}</td><td>${esc(h.kind)}</td><td class="num">${kr(h.price)}</td><td class="hide-sm muted">${esc(h.label ?? "")}</td></tr>`).join("")}
</table>`;
}

function sparkline(days: string[], series: Array<{ label: string; color: string; values: Array<number | null> }>, min: number, max: number): string {
  const w = 600, h = 110, pad = 6;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, days.length - 1);
  const y = (v: number) => h - pad - ((v - min) / Math.max(0.01, max - min)) * (h - 2 * pad);
  const paths = series
    .map((s) => {
      const pts = s.values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
      return pts.length ? `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${pts.join(" ")}"><title>${esc(s.label)}</title></polyline>` : "";
    })
    .join("");
  const legend = series.map((s) => `<span style="color:${s.color}">■</span> ${esc(s.label)}`).join(" &nbsp; ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price history">${paths}</svg>
<div class="muted">${legend} · ${kr(min)} to ${kr(max)}, ${esc(days[0])} to ${esc(days.at(-1))}</div>`;
}

export function homePage(latest: WeekView | null, recent: WeekView[], list: ListItem[], pantry: PantryItem[]): string {
  const short = pantry.filter((p) => p.status !== "have");
  return `<h1>This week</h1>
${latest ? `<div class="card"><div class="row" style="justify-content:space-between"><strong>Pickup ${esc(latest.week.id)}</strong>${badge(latest.week.status)}</div>
<ul>${latest.dishes.map((d) => `<li>${esc(d.name)}</li>`).join("")}</ul><a href="/plans/${esc(latest.week.id)}">Open the plan</a></div>` : `<p class="muted">No plan yet.</p>`}
<form method="post" action="/plans/new" class="row"><button>Plan the next pickup now</button><span class="muted">Takes about a minute, then it is emailed to everyone. Does nothing if that week is already planned.</span></form>
<h2>On the list (${list.length})</h2>
${list.length ? `<ul>${list.map((i) => `<li>${esc(i.text)}${i.quantity ? ` × ${esc(i.quantity)}` : ""} <span class="muted">${esc(i.addedBy)}</span></li>`).join("")}</ul>` : `<p class="muted">Nothing yet.</p>`}
<p><a href="/list">Add to the list</a></p>
<h2>Running low (${short.length})</h2>
${short.length ? `<ul>${short.map((p) => `<li>${esc(p.name)} ${badge(p.status)}</li>`).join("")}</ul>` : `<p class="muted">Nothing marked low or out.</p>`}
<h2>Earlier menus</h2>
${weeksTable(recent)}`;
}
