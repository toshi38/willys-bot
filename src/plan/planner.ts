import { readFileSync } from "node:fs";
import { z } from "zod";
import { runClaude } from "../core/claude.ts";
import type { Context } from "../core/context.ts";
import { picksDishes, suggestionCount } from "../core/household.ts";
import { needsCategory, productFacts, ruleProblems } from "../core/rules.ts";
import type { ListItem, WeekItem } from "../core/store.ts";
import { recipeProblems } from "../recipes/check.ts";
import { Recipe, recipeText } from "../recipes/recipe.ts";

// The week's first draft, made by headless Claude Code (`claude -p`) on the
// operator's Claude subscription. Claude gets the household's preferences,
// the open shopping list, the pantry, this week's offers and the recent
// menus, and can search Willys and read price history through this
// project's MCP server in read-only mode. It returns dishes with recipes and
// the exact products and quantities to buy. The draft is checked before it
// is written as the week's rows; later changes edit those rows instead of
// asking for a new draft.

// The CLI's schema check is not strict about every field, so the output is
// validated again here, with defaults for the parts that may be left out.
const DraftOutput = z.object({
  summary: z.string(),
  dishes: z.array(
    z.object({
      name: z.string(),
      portions: z.number().int().min(1),
      why: z.string().default(""),
      origin: z.string().default(""),
      recipeId: z.number().int().default(0),
      // Checked with recipeProblems, which says what to fix in words the
      // planner can act on, rather than parsed here.
      recipe: z.unknown().optional(),
    }),
  ),
  lines: z.array(
    z.object({
      productCode: z.string(),
      qty: z.number().int().min(1),
      reason: z.string().default(""),
      dish: z.number().int().default(0),
      listItemIds: z.array(z.number().int()).default([]),
      restocks: z.string().default(""),
    }),
  ),
  skipped: z.array(z.object({ listItemId: z.number().int(), reason: z.string() })).default([]),
  notes: z.string().default(""),
});
export type Draft = z.infer<typeof DraftOutput>;

const { $schema: _, ...RECIPE_SCHEMA } = z.toJSONSchema(Recipe, { io: "input" }) as Record<string, unknown>;

// How to write a recipe: the project's recipe-writing skill, without its
// front matter, so the planner and Claude Code sessions follow one text.
const RECIPE_RULES = readFileSync(new URL("../../.claude/skills/recipe-writing/SKILL.md", import.meta.url), "utf8")
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .replace(/^# .*\n/m, "")
  .trim();

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences on the week: what is on sale, what changed from usual." },
    dishes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          portions: { type: "integer", minimum: 1 },
          why: { type: "string", description: "Why this dish this week: offers used, flavour, protein" },
          origin: { type: "string", description: "For the wildcard dish only: the country it comes from. Empty for every other dish." },
          recipeId: { type: "integer", description: "Id of a known recipe this dish reuses as it is, or 0 for a new one" },
          recipe: { ...RECIPE_SCHEMA, description: "The whole meal as ingredients and ordered steps, for the dish's portions. Leave out only when reusing a known recipe that has steps." },
        },
        required: ["name", "portions", "why", "origin", "recipeId"],
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productCode: { type: "string" },
          qty: { type: "integer", minimum: 1 },
          reason: { type: "string", description: "What this is for, and a price note when relevant" },
          dish: { type: "integer", description: "1-based number of the dish this is for, or 0 for none" },
          listItemIds: { type: "array", items: { type: "integer" } },
          restocks: { type: "string", description: "Exact name of the pantry entry this restocks, or empty" },
        },
        required: ["productCode", "qty", "reason", "dish", "listItemIds", "restocks"],
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        properties: { listItemId: { type: "integer" }, reason: { type: "string" } },
        required: ["listItemId", "reason"],
      },
    },
    notes: { type: "string", description: "Anything the household should check before approving" },
  },
  required: ["summary", "dishes", "lines", "skipped", "notes"],
};

export const SYSTEM_PROMPT = `You do the weekly grocery shop for a household at Willys, a Swedish discount supermarket. You plan the week's dishes, write their recipes, and pick the exact products to order for click-and-collect.

Work like a careful, thrifty person who knows this household:
- Follow the household's preferences closely. They override your own ideas. Dietary rules such as allergies and celiac disease are absolute: check product names and ask yourself whether the product could contain the allergen; when unsure, choose a product labelled free of it, or leave it out and say so in notes.
- The pantry list is what the household has at home. Do not buy anything marked "have". Restock items marked "low" or "out" when they are needed this week or are a staple, and set restocks to the pantry entry's exact name.
- Shop the sales: prefer dinners built around this week's offers, and stock up on staples whose price verdict is "great". Do not buy something just because it is on offer.
- Every open shopping-list item must be covered by a line (listing its id in listItemIds) or appear in "skipped" with a reason. Items with a productCode are already pinned: use that product.
- Use search_products to find real products and codes. Never invent a product code. Check sizes so quantities make sense for the number of people and leftovers.
- Use comparePrice (price per kg or litre) to pick between similar products, and price_history or the verdict to judge an offer.
- Mind multi-buy offers ("3 för 50"): only meet the quantity when the household will use it.
- Keep near the budget when one is given; say in notes if you go over and why.
- Every dish needs a full recipe, written as the section "How to write a recipe" below says, and the products to cook it. The recipe is the whole meal: whatever is served with the dish (rice, pasta, potatoes, bread, a salad) is in its ingredients and has steps that make it. Link each line to the dish it is for; lines for no dish (list items, restocks, everyday basics) use dish 0.
- Vary the menu from recent weeks. Reuse a known recipe by its id when it suits the week, and keep its name. A known recipe without steps (recipe_view shows structured as null) must be written out in full as the dish's recipe.
- Learn from the household's ratings (1 to 5 stars, with comments): bring back recipes rated 4 or more now and then, never suggest one rated 2 or less again, and take the comments into account for new dishes.
- When the household picks some of your suggestions, make them a real choice: different proteins, cuisines and effort, each dish with its own products so any of them can be ordered without the others.
- Items already in this week's shop are fixed: do not add them again and do not plan around removing them.
- Only answer once the plan is complete. Never return a draft, a placeholder or an invented product code.
- The household's brand and gluten rules are checked in code after you answer. search_products marks products of an avoided brand and products that look like they contain gluten. Avoid both. If you must buy one, start that line's reason with "Brand exception:" (every other brand costs more than double) or "Gluten checked:" (you know it is gluten free) and say why; otherwise the plan is rejected.
Write the summary, reasons, notes and recipes in the household's language. Never use em dashes or en dashes; use commas, colons or full stops.

# How to write a recipe

${RECIPE_RULES}`;

export interface DraftInput {
  // Items already in the week, kept as they are (a redraft keeps requests
  // and the ingredients of dishes members added).
  fixed: WeekItem[];
  // Dishes a redraft keeps: those a member added or picked.
  keptDishes: string[];
  // True when a kept dish is already the week's wildcard.
  keptWildcard?: boolean;
  // What the household asked for when asking for a new draft.
  instructions: string | null;
  // Dishes the household wants a redraft to move away from.
  replacing: string[];
}

// How many dishes a draft plans: the week's suggestions less the dishes it
// keeps.
export function dishesWanted(ctx: Context, input: DraftInput): number {
  return Math.max(0, suggestionCount(ctx.household) - input.keptDishes.length);
}

// Whether the draft must include the week's wildcard dish.
export function wildcardWanted(ctx: Context, input: DraftInput): boolean {
  return ctx.household.config.plan.wildcard && !input.keptWildcard && dishesWanted(ctx, input) >= 2;
}

export function buildPrompt(ctx: Context, weekId: string, input: DraftInput): string {
  const { household, store } = ctx;
  const c = household.config;
  const want = dishesWanted(ctx, input);
  const count = picksDishes(household)
    ? `Suggest ${want} dishes of about ${c.plan.portionsPerMeal} portions each. The household picks about ${c.plan.meals} of the week's suggestions to cook, and only the picked dishes are bought.`
    : `Plan ${want} dishes of about ${c.plan.portionsPerMeal} portions each.`;
  const wildcard = wildcardWanted(ctx, input)
    ? ` Make exactly one of them a wildcard: home cooking from another country that the household has probably never heard of, not a well known dish like pizza, tacos, pad thai or butter chicken. Set its origin to the country, say in why what makes it special, keep it doable with ingredients from Willys, and follow the dietary rules as for any dish.`
    : "";
  const ratings = store.recipeRatings();
  const list = openRequests(ctx, input.fixed);
  const pantry = store.pantryItems();
  const offers = store.currentOffers(undefined, 400);
  const past = store.pastDishes(weekId, 24);
  const recipes = store.recipes().slice(0, 60);
  const lines = [
    `Household: ${c.name}. ${c.plan.people} people. ${count}${wildcard}${c.plan.budgetSek ? ` Budget about ${c.plan.budgetSek} kr${picksDishes(household) ? ` for the basics and ${c.plan.meals} dishes` : ""}.` : ""} Language: ${c.plan.language === "sv" ? "Swedish" : "English"}.`,
    `Today is ${new Date().toISOString().slice(0, 10)}. This shop is picked up on ${weekId}.`,
    "",
    "## Preferences",
    household.preferences || "(none written yet)",
    "",
    "## Pantry (at home)",
    pantry.length ? pantry.map((p) => `- ${p.name}: ${p.status}${p.quantity ? `, ${p.quantity}` : ""}${p.note ? ` (${p.note})` : ""}`).join("\n") : "(not recorded yet: assume a normal stocked kitchen with salt, oil and common spices)",
    "",
    "## Open shopping list",
    list.length
      ? list.map((i) => `- #${i.id} ${i.text}${i.quantity ? ` x ${i.quantity}` : ""}${i.note ? ` (${i.note})` : ""}${i.productCode ? ` [pinned ${i.productCode}]` : ""}, added by ${i.addedBy}`).join("\n")
      : "(empty)",
  ];
  if (input.fixed.length) {
    lines.push("", "## Already in this week's shop (fixed)", ...input.fixed.map((i) => `- ${i.qty} x ${i.name ?? i.productCode} [${i.productCode}]${i.requestedBy ? `, asked for by ${i.requestedBy}` : ""}`));
  }
  lines.push(
    "",
    "## Recent dishes (newest first)",
    past.length ? past.map((d) => `- ${d.weekId}: ${d.name}${d.status === "applied" ? " (ordered)" : ""}`).join("\n") : "(none yet)",
    "",
    "## Known recipes (id: name)",
    recipes.length ? recipes.map((r) => `- ${r.id}: ${r.name}`).join("\n") : "(none yet)",
    "",
    "## How the household rated dishes they cooked (best first)",
    ratings.length
      ? ratings.map((r) => `- ${r.name} (recipe ${r.recipeId}): ${r.average} of 5 from ${r.count} rating${r.count === 1 ? "" : "s"}${r.comments.length ? `: ${r.comments.map((c) => `"${c}"`).join("; ")}` : ""}`).join("\n")
      : "(no ratings yet)",
    "",
    "## This week's online offers at the store (code, name, size, offer price, regular price, label)",
    offers.length
      ? offers.map((o) => `${o.code} | ${o.name} | ${o.volume ?? ""} | ${o.price} | ${o.regular ?? ""} | ${o.label ?? ""}`).join("\n")
      : "(no snapshot yet: use search_products and current_offers)",
  );
  if (input.keptDishes.length) lines.push("", "## Dishes staying this week (already bought for; plan only the rest)", ...input.keptDishes.map((d) => `- ${d}`));
  if (input.replacing.length) lines.push("", "## Dishes being replaced (do not plan these again)", ...input.replacing.map((d) => `- ${d}`));
  if (input.instructions) lines.push("", "## What the household asked for (follow it)", input.instructions);
  return lines.join("\n");
}

// Open list items the draft must cover: those not already in the week.
export function openRequests(ctx: Context, fixed: WeekItem[]): ListItem[] {
  const inWeek = new Set(fixed.map((i) => i.listItemId).filter((id): id is number => id !== null));
  return ctx.store.listItems().filter((i) => !inWeek.has(i.id));
}

// Drafts the week, checking the result and asking once more with the
// problems spelled out when it falls short.
export async function makeDraft(ctx: Context, weekId: string, input: DraftInput): Promise<Draft> {
  let prompt = buildPrompt(ctx, weekId, input);
  for (let attempt = 1; ; attempt++) {
    const output = await runClaude(ctx, {
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      schema: DRAFT_SCHEMA,
      tools: ["search_products", "current_offers", "price_history", "list_view", "pantry_view", "recipe_view"],
      member: "planner",
      readOnly: true,
    });
    const parsed = DraftOutput.safeParse(output);
    // Rules on categories need the products' categories, looked up once.
    if (parsed.success) for (const l of parsed.data.lines) await productFacts(ctx, l.productCode).catch(() => null);
    const problems = parsed.success ? checkDraft(ctx, parsed.data, input) : [`The answer did not match the schema: ${parsed.error.message.slice(0, 300)}`];
    if (!problems.length && parsed.success) return parsed.data;
    if (attempt >= 3) throw new Error(`The planner's draft failed its checks three times: ${problems.join("; ")}`);
    prompt = `${buildPrompt(ctx, weekId, input)}\n\n## Your previous answer was rejected\n${problems.map((p) => `- ${p}`).join("\n")}\nPlan the whole week again and fix these.`;
  }
}

// What is wrong with a draft, if anything: the checks that keep a broken
// or half-finished plan from reaching the household.
export function checkDraft(ctx: Context, d: Draft, input: DraftInput): string[] {
  const problems: string[] = [];
  const want = dishesWanted(ctx, input);
  if (/^\s*(draft|placeholder|todo|tbd)?\s*$/i.test(d.summary) || d.summary.trim().length < 20) problems.push("The summary is missing or a placeholder.");
  if (want > 0 && d.dishes.length !== want) problems.push(`Plan exactly ${want} dishes, not ${d.dishes.length}.`);
  const wildcards = d.dishes.filter((dish) => dish.origin.trim());
  if (wildcardWanted(ctx, input) && wildcards.length !== 1) problems.push(`Make exactly one dish the wildcard, with its country in origin, not ${wildcards.length}.`);
  if (!wildcardWanted(ctx, input) && wildcards.length) problems.push("No wildcard is wanted: leave origin empty for every dish.");
  d.dishes.forEach((dish, i) => {
    if (!d.lines.some((l) => l.dish === i + 1)) problems.push(`Dish ${i + 1} (${dish.name}) has no products.`);
    problems.push(...dishRecipeProblems(ctx, dish).map((p) => `Dish ${i + 1} (${dish.name}): ${p}`));
  });
  for (const l of d.lines) {
    const name = ctx.store.productName(l.productCode);
    if (!name || ctx.store.latestPrice(l.productCode) === null) problems.push(`Product ${l.productCode} is unknown: use a code from search_products or the offers.`);
    else {
      const facts = { code: l.productCode, name, brand: ctx.store.productBrand(l.productCode), category: ctx.store.productCategory(l.productCode) ?? undefined };
      if (needsCategory(ctx.household, facts)) problems.push(`Could not look up the category of ${name} (${l.productCode}) to check the household's rules: pick another product.`);
      else problems.push(...ruleProblems(ctx.household, facts, l.reason));
    }
    if (l.dish < 0 || l.dish > d.dishes.length) problems.push(`Line ${l.productCode} points at dish ${l.dish}, which does not exist.`);
  }
  const budget = ctx.household.config.plan.budgetSek;
  if (budget) {
    // With picking, the budget covers the basics and as many dishes as the
    // household cooks, so the dishes count at their average cost.
    const cost = (l: Draft["lines"][number]) => l.qty * (ctx.store.latestPrice(l.productCode) ?? 0);
    const basics = [...d.lines.filter((l) => l.dish === 0).map(cost), ...input.fixed.map((i) => i.qty * (i.unitPrice ?? 0))].reduce((a, b) => a + b, 0);
    const dishes = d.lines.filter((l) => l.dish > 0).map(cost).reduce((a, b) => a + b, 0);
    const cooked = picksDishes(ctx.household) && d.dishes.length ? (dishes / d.dishes.length) * Math.min(ctx.household.config.plan.meals, d.dishes.length) : dishes;
    const total = basics + cooked;
    if (total > budget * 1.15) {
      problems.push(
        picksDishes(ctx.household)
          ? `The basics and ${ctx.household.config.plan.meals} average dishes come to about ${Math.round(total)} kr, well over the ${budget} kr budget: use cheaper products or offers, or smaller quantities.`
          : `The shop comes to about ${Math.round(total)} kr, well over the ${budget} kr budget: use cheaper products or offers, or smaller quantities.`,
      );
    }
  }
  const covered = new Set([...d.lines.flatMap((l) => l.listItemIds), ...d.skipped.map((s) => s.listItemId)]);
  for (const i of openRequests(ctx, input.fixed)) if (!covered.has(i.id)) problems.push(`List item #${i.id} (${i.text}) is neither bought nor skipped.`);
  return problems;
}

// What is wrong with a dish's recipe: a new one must pass the recipe
// checks and be for the dish's portions; a reused one must have steps.
export function dishRecipeProblems(ctx: Context, dish: { portions: number; recipeId?: number; recipe?: unknown }): string[] {
  if (dish.recipe !== undefined && dish.recipe !== null) {
    const problems = recipeProblems(dish.recipe);
    const servings = Recipe.safeParse(dish.recipe).data?.servings;
    if (servings !== undefined && servings !== dish.portions) problems.push(`The recipe is for ${servings} servings but the dish is ${dish.portions} portions: write it for ${dish.portions}.`);
    return problems;
  }
  const known = dish.recipeId ? ctx.store.recipe(dish.recipeId) : null;
  if (!known) return ["It needs a recipe."];
  if (!known.structured) return [`Recipe ${known.id} has no steps yet: write it out in full as the dish's recipe.`];
  return [];
}

// Saves a checked dish's recipe, or finds the known one it reuses.
export function dishRecipeId(ctx: Context, dish: { name: string; recipeId?: number; recipe?: unknown }, by: string): number {
  if (dish.recipe !== undefined && dish.recipe !== null) {
    const r = Recipe.parse(dish.recipe);
    return ctx.store.saveRecipe({ name: dish.name, servings: r.servings, ...recipeText(r), notes: r.notes ?? null, structured: r }, by).id;
  }
  return ctx.store.recipe(dish.recipeId!)!.id;
}

// Writes a checked draft as the week's dishes, recipes and items. Lines
// that cover a list item are requests from whoever added the item; lines
// for a dish go with it; the rest are staples.
export function writeDraft(ctx: Context, weekId: string, d: Draft): void {
  const { store } = ctx;
  const list = new Map(store.listItems().map((i) => [i.id, i]));
  store.transaction(() => {
    const dishIds = d.dishes.map((dish) => {
      const recipeId = dishRecipeId(ctx, dish, "planner");
      return store.addDish(weekId, { name: dish.name, portions: dish.portions, why: dish.why, recipeId, origin: dish.origin.trim() || null }, "planner").id;
    });
    for (const l of d.lines) {
      const listItem = l.listItemIds.map((id) => list.get(id)).find((i) => i !== undefined);
      store.addItem(
        weekId,
        {
          productCode: l.productCode,
          qty: l.qty,
          reason: l.reason,
          source: listItem ? "request" : l.dish > 0 ? "dish" : "staple",
          requestedBy: listItem?.addedBy ?? null,
          listItemId: listItem?.id ?? null,
          dishId: l.dish > 0 ? dishIds[l.dish - 1] : null,
          restocks: l.restocks || null,
        },
        "planner",
      );
      for (const id of l.listItemIds) if (list.has(id)) store.updateListItem(id, { status: "planned", weekId });
    }
    const skipped = d.skipped.map((s) => `- Not bought: ${list.get(s.listItemId)?.text ?? `list item #${s.listItemId}`}, ${s.reason}`);
    store.updateWeek(weekId, { summary: d.summary, notes: [d.notes, ...skipped].filter(Boolean).join("\n") });
  });
}
