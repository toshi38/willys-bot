import { z } from "zod";
import { runClaude } from "../core/claude.ts";
import type { Context } from "../core/context.ts";
import type { PlanLine } from "../core/store.ts";

// The weekly plan, made by headless Claude Code (`claude -p`) on the
// operator's Claude subscription. Claude gets the household's preferences,
// the open shopping list, the pantry and this week's offers, and can search Willys and
// read price history through this project's MCP server in read-only mode.
// It returns a menu and the exact products and quantities to buy; nothing
// is put in the cart until a member approves the plan by email.

// The CLI's schema check is not strict about every field, so the output is
// validated again here, with defaults for the parts that may be left out.
const PlanOutput = z.object({
  summary: z.string(),
  meals: z.array(z.object({ dish: z.string(), portions: z.number().int(), why: z.string().default("") })),
  lines: z.array(
    z.object({
      productCode: z.string(),
      qty: z.number().int().min(1),
      reason: z.string().default(""),
      listItemIds: z.array(z.number().int()).default([]),
      restocks: z.string().default(""),
    }),
  ),
  skipped: z.array(z.object({ listItemId: z.number().int(), reason: z.string() })).default([]),
  notes: z.string().default(""),
});
export type Plan = z.infer<typeof PlanOutput>;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences on the week: what is on sale, what changed from usual." },
    meals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dish: { type: "string" },
          portions: { type: "integer", minimum: 1 },
          why: { type: "string", description: "Why this dish this week: offers used, flavour, protein" },
        },
        required: ["dish", "portions", "why"],
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productCode: { type: "string" },
          qty: { type: "integer", minimum: 1 },
          reason: { type: "string", description: "Which dinner or list item this is for, and a price note when relevant" },
          listItemIds: { type: "array", items: { type: "integer" } },
          restocks: { type: "string", description: "Exact name of the pantry entry this restocks, or empty" },
        },
        required: ["productCode", "qty", "reason", "listItemIds", "restocks"],
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
  required: ["summary", "meals", "lines", "skipped", "notes"],
};

const SYSTEM_PROMPT = `You do the weekly grocery shop for a household at Willys, a Swedish discount supermarket. You plan the week's dishes and pick the exact products to order for click-and-collect.

Work like a careful, thrifty person who knows this household:
- Follow the household's preferences closely. They override your own ideas. Dietary rules such as allergies and celiac disease are absolute: check product names and ask yourself whether the product could contain the allergen; when unsure, choose a product labelled free of it, or leave it out and say so in notes.
- The pantry list is what the household has at home. Do not buy anything marked "have". Restock items marked "low" or "out" when they are needed this week or are a staple, and set restocks to the pantry entry's exact name.
- Shop the sales: prefer dinners built around this week's offers, and stock up on staples whose price verdict is "great". Do not buy something just because it is on offer.
- Every open shopping-list item must be covered by a line (listing its id in listItemIds) or appear in "skipped" with a reason. Items with a productCode are already pinned: use that product.
- Use search_products to find real products and codes. Never invent a product code. Check sizes so quantities make sense for the number of people and leftovers.
- Use comparePrice (price per kg or litre) to pick between similar products, and price_history or the verdict to judge an offer.
- Mind multi-buy offers ("3 för 50"): only meet the quantity when the household will use it.
- Keep near the budget when one is given; say in notes if you go over and why.
Write the summary, reasons and notes in the household's language. Never use em dashes or en dashes; use commas, colons or full stops.`;

export function buildPrompt(ctx: Context, feedback: string | null): string {
  const { household, store } = ctx;
  const c = household.config;
  const list = store.listItems();
  const pantry = store.pantryItems();
  const offers = store.currentOffers(undefined, 400);
  const lines = [
    `Household: ${c.name}. ${c.plan.people} people. Plan ${c.plan.meals} dishes of about ${c.plan.portionsPerMeal} portions each.${c.plan.budgetSek ? ` Budget about ${c.plan.budgetSek} kr.` : ""} Language: ${c.plan.language === "sv" ? "Swedish" : "English"}.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
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
    "",
    "## This week's online offers at the store (code, name, size, offer price, regular price, label)",
    offers.length
      ? offers.map((o) => `${o.code} | ${o.name} | ${o.volume ?? ""} | ${o.price} | ${o.regular ?? ""} | ${o.label ?? ""}`).join("\n")
      : "(no snapshot yet: use search_products and current_offers)",
  ];
  if (feedback) lines.push("", "## Feedback on the previous plan (follow it)", feedback);
  return lines.join("\n");
}

export async function makePlan(ctx: Context, feedback: string | null = null): Promise<Plan> {
  const output = await runClaude(ctx, {
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildPrompt(ctx, feedback),
    schema: PLAN_SCHEMA,
    tools: ["search_products", "current_offers", "price_history", "list_view", "pantry_view"],
    member: "planner",
    readOnly: true,
  });
  return PlanOutput.parse(output);
}

// Resolves the plan's product codes to names and prices from the database
// (filled by the planner's searches), dropping codes nobody ever saw.
export function planLines(ctx: Context, plan: Plan): { lines: PlanLine[]; unknown: string[] } {
  const lines: PlanLine[] = [];
  const unknown: string[] = [];
  for (const l of plan.lines) {
    const name = ctx.store.productName(l.productCode);
    const price = ctx.store.latestPrice(l.productCode);
    if (!name || price === null) {
      unknown.push(l.productCode);
      continue;
    }
    lines.push({ productCode: l.productCode, name, qty: l.qty, unitPrice: price, reason: l.reason, listItemIds: l.listItemIds, restocks: l.restocks || null });
  }
  return { lines, unknown };
}
