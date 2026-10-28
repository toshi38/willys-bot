import { z } from "zod";
import { runClaude } from "../core/claude.ts";
import type { Context } from "../core/context.ts";
import type { ListItem, WeekItem } from "../core/store.ts";

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
      recipeId: z.number().int().default(0),
      recipe: z.object({ servings: z.number().int().default(0), ingredients: z.array(z.string()).default([]), method: z.string().default("") }).default({ servings: 0, ingredients: [], method: "" }),
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
          recipeId: { type: "integer", description: "Id of a known recipe this dish reuses, or 0 for a new one" },
          recipe: {
            type: "object",
            properties: {
              servings: { type: "integer" },
              ingredients: { type: "array", items: { type: "string" }, description: "With amounts, for the portions" },
              method: { type: "string", description: "A few short numbered steps" },
            },
            required: ["servings", "ingredients", "method"],
          },
        },
        required: ["name", "portions", "why", "recipeId", "recipe"],
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

const SYSTEM_PROMPT = `You do the weekly grocery shop for a household at Willys, a Swedish discount supermarket. You plan the week's dishes, write their recipes, and pick the exact products to order for click-and-collect.

Work like a careful, thrifty person who knows this household:
- Follow the household's preferences closely. They override your own ideas. Dietary rules such as allergies and celiac disease are absolute: check product names and ask yourself whether the product could contain the allergen; when unsure, choose a product labelled free of it, or leave it out and say so in notes.
- The pantry list is what the household has at home. Do not buy anything marked "have". Restock items marked "low" or "out" when they are needed this week or are a staple, and set restocks to the pantry entry's exact name.
- Shop the sales: prefer dinners built around this week's offers, and stock up on staples whose price verdict is "great". Do not buy something just because it is on offer.
- Every open shopping-list item must be covered by a line (listing its id in listItemIds) or appear in "skipped" with a reason. Items with a productCode are already pinned: use that product.
- Use search_products to find real products and codes. Never invent a product code. Check sizes so quantities make sense for the number of people and leftovers.
- Use comparePrice (price per kg or litre) to pick between similar products, and price_history or the verdict to judge an offer.
- Mind multi-buy offers ("3 för 50"): only meet the quantity when the household will use it.
- Keep near the budget when one is given; say in notes if you go over and why.
- Every dish needs a short recipe (ingredients with amounts for its portions, and a method of a few steps) and the products to cook it. Link each line to the dish it is for; lines for no dish (list items, restocks, everyday basics) use dish 0.
- Vary the menu from recent weeks. Reuse a known recipe by its id when it suits the week, and keep its name.
- Items already in this week's shop are fixed: do not add them again and do not plan around removing them.
- Only answer once the plan is complete. Never return a draft, a placeholder or an invented product code.
Write the summary, reasons and notes in the household's language. Never use em dashes or en dashes; use commas, colons or full stops.`;

export interface DraftInput {
  // Items already in the week, kept as they are (a redraft keeps requests
  // and the ingredients of dishes members added).
  fixed: WeekItem[];
  // Dishes a member added, which a redraft keeps.
  keptDishes: string[];
  // What the household asked for when asking for a new draft.
  instructions: string | null;
  // Dishes the household wants a redraft to move away from.
  replacing: string[];
}

export function buildPrompt(ctx: Context, weekId: string, input: DraftInput): string {
  const { household, store } = ctx;
  const c = household.config;
  const list = openRequests(ctx, input.fixed);
  const pantry = store.pantryItems();
  const offers = store.currentOffers(undefined, 400);
  const past = store.pastDishes(weekId, 24);
  const recipes = store.recipes().slice(0, 60);
  const lines = [
    `Household: ${c.name}. ${c.plan.people} people. Plan ${Math.max(0, c.plan.meals - input.keptDishes.length)} dishes of about ${c.plan.portionsPerMeal} portions each.${c.plan.budgetSek ? ` Budget about ${c.plan.budgetSek} kr.` : ""} Language: ${c.plan.language === "sv" ? "Swedish" : "English"}.`,
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
    const problems = parsed.success ? checkDraft(ctx, parsed.data, input) : [`The answer did not match the schema: ${parsed.error.message.slice(0, 300)}`];
    if (!problems.length && parsed.success) return parsed.data;
    if (attempt >= 2) throw new Error(`The planner's draft failed its checks twice: ${problems.join("; ")}`);
    prompt = `${buildPrompt(ctx, weekId, input)}\n\n## Your previous answer was rejected\n${problems.map((p) => `- ${p}`).join("\n")}\nPlan the whole week again and fix these.`;
  }
}

// What is wrong with a draft, if anything: the checks that keep a broken
// or half-finished plan from reaching the household.
export function checkDraft(ctx: Context, d: Draft, input: DraftInput): string[] {
  const problems: string[] = [];
  const want = Math.max(0, ctx.household.config.plan.meals - input.keptDishes.length);
  if (/^\s*(draft|placeholder|todo|tbd)?\s*$/i.test(d.summary) || d.summary.trim().length < 20) problems.push("The summary is missing or a placeholder.");
  if (want > 0 && d.dishes.length !== want) problems.push(`Plan exactly ${want} dishes, not ${d.dishes.length}.`);
  d.dishes.forEach((dish, i) => {
    if (!d.lines.some((l) => l.dish === i + 1)) problems.push(`Dish ${i + 1} (${dish.name}) has no products.`);
    const known = dish.recipeId > 0 && ctx.store.recipe(dish.recipeId);
    if (!known && (!dish.recipe.ingredients.length || dish.recipe.method.trim().length < 20)) problems.push(`Dish ${i + 1} (${dish.name}) needs a recipe.`);
  });
  for (const l of d.lines) {
    if (!ctx.store.productName(l.productCode) || ctx.store.latestPrice(l.productCode) === null) problems.push(`Product ${l.productCode} is unknown: use a code from search_products or the offers.`);
    if (l.dish < 0 || l.dish > d.dishes.length) problems.push(`Line ${l.productCode} points at dish ${l.dish}, which does not exist.`);
  }
  const covered = new Set([...d.lines.flatMap((l) => l.listItemIds), ...d.skipped.map((s) => s.listItemId)]);
  for (const i of openRequests(ctx, input.fixed)) if (!covered.has(i.id)) problems.push(`List item #${i.id} (${i.text}) is neither bought nor skipped.`);
  return problems;
}

// Writes a checked draft as the week's dishes, recipes and items. Lines
// that cover a list item are requests from whoever added the item; lines
// for a dish go with it; the rest are staples.
export function writeDraft(ctx: Context, weekId: string, d: Draft): void {
  const { store } = ctx;
  const list = new Map(store.listItems().map((i) => [i.id, i]));
  store.transaction(() => {
    const dishIds = d.dishes.map((dish) => {
      const reused = dish.recipeId > 0 ? store.recipe(dish.recipeId) : null;
      const recipe =
        reused ??
        store.saveRecipe({ name: dish.name, servings: dish.recipe.servings || dish.portions, ingredients: dish.recipe.ingredients.join("\n"), method: dish.recipe.method }, "planner");
      return store.addDish(weekId, { name: dish.name, portions: dish.portions, why: dish.why, recipeId: recipe.id }, "planner").id;
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
