import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../core/context.ts";
import { judgePrice, recordSearchResults } from "../core/prices.ts";
import { savePreferences } from "../core/household.ts";
import type { PantryStatus } from "../core/store.ts";

// The household's MCP tools: the shared shopping list, the pantry, product
// search with a price verdict, offers and price history. Nothing here touches the Willys
// cart or places an order; that only happens in the weekly run after an
// approval email.

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const PREFERENCES_HISTORY = "preferences.history";

// readOnly leaves out the list-changing tools, for the weekly planner.
export function buildServer(ctx: Context, member: string, { readOnly = false, week }: { readOnly?: boolean; week?: string } = {}): McpServer {
  const { store, willys, household } = ctx;
  const server = new McpServer(
    { name: "willys-bot", version: "0.1.0" },
    {
      instructions: `Shared grocery list and Willys price lookup for ${household.config.name}. You are talking to ${member}.
Items added to the list go into the next weekly shop. Once a week's shop is drafted, change it with the week_ tools and dish_ tools; a household member approves it by email or Slack.
When someone asks for something, search for matching products, compare the options on price per unit and the price verdict, and suggest one, but let them choose when it is a matter of taste.
The pantry is what the household keeps at home. The weekly planner never buys pantry items marked "have" and restocks ones marked "low" or "out". When someone says they used up or are running low on something, update the pantry with pantry_set rather than the shopping list, unless they need it this week.
If they share a photo of a handwritten list, read it, tell them what you read (flag words you are unsure of), and add the items with list_add once they confirm.
Prices are in SEK. Verdicts compare today's price with what this household has seen before: "great" and "good" are worth stocking up on.`,
    },
  );

  server.registerTool(
    "list_view",
    { description: "Show the open shopping list: items waiting for the next order.", inputSchema: {} },
    async () => text(store.listItems().map(({ id, text: t, quantity, note, productCode, addedBy, addedAt }) => ({ id, text: t, quantity, note, productCode, productName: productCode ? store.productName(productCode) : null, addedBy, addedAt }))),
  );

  if (!readOnly) server.registerTool(
    "list_add",
    {
      description:
        "Add items to the shopping list. Use a plain description (\"mellanmjölk\", \"diskmedel\"), and a productCode from search_products when the person has picked a specific product.",
      inputSchema: {
        items: z
          .array(
            z.object({
              text: z.string().min(1).describe("What to buy, as the person said it"),
              quantity: z.string().optional().describe("For example \"2\", \"1 kg\", \"a big pack\""),
              note: z.string().optional().describe("Brand, size or other wishes"),
              productCode: z.string().optional().describe("Willys product code, for example 101205823_ST"),
            }),
          )
          .min(1),
      },
    },
    async ({ items }) => text(items.map((i) => store.addListItem({ ...i, addedBy: member }))),
  );

  if (!readOnly) server.registerTool(
    "list_update",
    {
      description: "Change an item on the list: pin it to a product, or change quantity or note.",
      inputSchema: {
        id: z.number().int(),
        productCode: z.string().nullable().optional(),
        quantity: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      },
    },
    async ({ id, ...patch }) => text(store.updateListItem(id, patch, member) ?? `No item #${id}`),
  );

  if (!readOnly) server.registerTool(
    "list_remove",
    { description: "Remove an item from the list.", inputSchema: { id: z.number().int() } },
    async ({ id }) => text(store.updateListItem(id, { status: "removed" }, member) ?? `No item #${id}`),
  );

  server.registerTool(
    "pantry_view",
    { description: "Show the pantry: what the household has at home, and what is low or out.", inputSchema: {} },
    async () => text(store.pantryItems()),
  );

  if (!readOnly) server.registerTool(
    "pantry_set",
    {
      description:
        "Add or update pantry entries. status is \"have\", \"low\" or \"out\". Use short generic names (\"jasmine rice\", \"Pearl River Bridge mushroom soy\") so later updates match.",
      inputSchema: {
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              status: z.enum(["have", "low", "out"]),
              quantity: z.string().optional(),
              note: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ items }) => text(items.map((i) => store.setPantryItem({ ...i, status: i.status as PantryStatus, updatedBy: member }))),
  );

  if (!readOnly) server.registerTool(
    "pantry_remove",
    { description: "Stop tracking a pantry entry.", inputSchema: { name: z.string().min(1) } },
    async ({ name }) => text(store.removePantryItem(name, member) ? `Removed ${name}` : `No pantry entry ${name}`),
  );

  // This week's shop: the open week's dishes and items, edited one at a
  // time so nothing else changes.
  // With `week` set (the week a message is about), the tools only touch
  // that week; otherwise the open one.
  const openWeek = () => {
    const w = week ? store.week(week) : store.openWeek();
    if (!w) throw new Error("No week is open for changes: it has been approved or skipped, or not drafted yet.");
    if (w.status !== "open") throw new Error(`The week for pickup ${w.id} is ${w.status}, so it cannot be changed.`);
    return w;
  };
  const weekView = () => {
    const w = openWeek();
    return {
      week: { pickup: w.id, status: w.status, summary: w.summary, notes: w.notes },
      dishes: store.dishes(w.id).map((d) => ({ id: d.id, name: d.name, portions: d.portions, why: d.why, recipeId: d.recipeId })),
      items: store.items(w.id).map((i) => ({
        id: i.id, qty: i.qty, product: i.name ?? i.productCode, productCode: i.productCode, unitPrice: i.unitPrice,
        source: i.source, requestedBy: i.requestedBy, dishId: i.dishId, reason: i.reason,
      })),
    };
  };

  server.registerTool(
    "week_view",
    {
      description:
        "Show this week's shop: its dishes and every item with its id. source says why an item is there: request (a member asked for it, requestedBy says who), dish (an ingredient of dishId) or staple (the planner's restock or basic).",
      inputSchema: {},
    },
    async () => text(weekView()),
  );

  if (!readOnly) server.registerTool(
    "week_add_item",
    {
      description:
        "Add a product to this week's shop. Without dishId it is a request from the person you are talking to, and stays until a member removes it. With dishId it is an ingredient of that dish. Find the productCode with search_products first.",
      inputSchema: {
        productCode: z.string(),
        qty: z.number().int().min(1).max(50),
        reason: z.string().describe("What it is for"),
        dishId: z.number().int().optional(),
        restocks: z.string().optional().describe("Exact name of the pantry entry this restocks"),
      },
    },
    async ({ productCode, qty, reason, dishId, restocks }) => {
      const w = openWeek();
      if (!store.productName(productCode)) throw new Error(`Unknown product ${productCode}: find it with search_products first`);
      const dish = dishId !== undefined ? store.dish(dishId) : null;
      if (dishId !== undefined && (dish?.weekId !== w.id || dish.removedAt)) throw new Error(`Dish ${dishId} is not in this week`);
      if (restocks && !store.pantryItems().some((p) => p.name === restocks)) throw new Error(`No pantry entry named "${restocks}": use the exact name from pantry_view`);
      const item = store.addItem(
        w.id,
        { productCode, qty, reason, source: dishId !== undefined ? "dish" : "request", requestedBy: dishId !== undefined ? null : member, dishId: dishId ?? null, restocks: restocks ?? null },
        member,
      );
      return text(item);
    },
  );

  if (!readOnly) server.registerTool(
    "week_set_quantity",
    { description: "Change how many of an item in this week's shop to buy.", inputSchema: { itemId: z.number().int(), qty: z.number().int().min(1).max(50) } },
    async ({ itemId, qty }) => {
      const w = openWeek();
      if (store.item(itemId)?.weekId !== w.id) throw new Error(`Item ${itemId} is not in this week`);
      return text(store.setItemQuantity(itemId, qty, member));
    },
  );

  if (!readOnly) server.registerTool(
    "week_remove_item",
    {
      description: "Remove an item from this week's shop. Only remove a request (source request) when a member asked for that.",
      inputSchema: { itemId: z.number().int() },
    },
    async ({ itemId }) => {
      const w = openWeek();
      if (store.item(itemId)?.weekId !== w.id) throw new Error(`Item ${itemId} is not in this week`);
      return text(store.removeItem(itemId, member) ? `Removed item ${itemId}` : `Item ${itemId} was already removed`);
    },
  );

  if (!readOnly) server.registerTool(
    "dish_add",
    {
      description:
        "Add a dish to this week's shop, with its recipe, or reuse a known recipe by recipeId. Then add its ingredients with week_add_item and the dish's id. To swap a dish, dish_remove the old one first.",
      inputSchema: {
        name: z.string().min(1),
        portions: z.number().int().min(1),
        why: z.string().describe("Why this dish: offers used, flavour, protein, or what the member asked for"),
        recipeId: z.number().int().optional(),
        ingredients: z.array(z.string()).optional().describe("With amounts, for the portions; needed without recipeId"),
        method: z.string().optional().describe("A few short numbered steps; needed without recipeId"),
      },
    },
    async ({ name, portions, why, recipeId, ingredients, method }) => {
      const w = openWeek();
      const recipe =
        recipeId !== undefined
          ? store.recipe(recipeId)
          : ingredients?.length && method
            ? store.saveRecipe({ name, servings: portions, ingredients: ingredients.join("\n"), method }, member)
            : null;
      if (!recipe) throw new Error(recipeId !== undefined ? `No recipe ${recipeId}` : "Give the recipe's ingredients and method, or a recipeId");
      return text(store.addDish(w.id, { name, portions, why, recipeId: recipe.id }, member));
    },
  );

  if (!readOnly) server.registerTool(
    "dish_remove",
    {
      description: "Remove a dish from this week's shop, with the ingredients bought for it. Requests stay.",
      inputSchema: { dishId: z.number().int() },
    },
    async ({ dishId }) => {
      const w = openWeek();
      if (store.dish(dishId)?.weekId !== w.id) throw new Error(`Dish ${dishId} is not in this week`);
      store.removeDish(dishId, member);
      return text(weekView());
    },
  );

  server.registerTool(
    "recipe_view",
    {
      description: "Read a recipe by id, or search the household's recipes by name.",
      inputSchema: { id: z.number().int().optional(), search: z.string().optional() },
    },
    async ({ id, search }) => text(id !== undefined ? (store.recipe(id) ?? `No recipe ${id}`) : store.recipes(search).map((r) => ({ id: r.id, name: r.name, servings: r.servings }))),
  );

  server.registerTool(
    "preferences_view",
    { description: "Show the household's food preferences: dietary rules, tastes, staples and shopping habits. The weekly planner follows them.", inputSchema: {} },
    async () => text(household.preferences || "(none written yet)"),
  );

  if (!readOnly) server.registerTool(
    "preferences_update",
    {
      description:
        "Replace the household's preferences (Markdown) with an edited version. Read them with preferences_view first, keep everything that still holds, and change only what the person asked for. The previous version is kept.",
      inputSchema: { markdown: z.string().min(1), change: z.string().min(1).describe("One line on what changed and who asked") },
    },
    async ({ markdown, change }) => {
      const history = JSON.parse(store.get(PREFERENCES_HISTORY) ?? "[]") as { at: string; by: string; change: string; previous: string }[];
      history.unshift({ at: new Date().toISOString(), by: member, change, previous: household.preferences });
      store.set(PREFERENCES_HISTORY, JSON.stringify(history.slice(0, 20)));
      savePreferences(household, markdown);
      store.logChange(member, `updated the preferences: ${change}`);
      return text(`Saved. ${change}`);
    },
  );

  server.registerTool(
    "search_products",
    {
      description:
        "Search Willys for products. Each result has its price, compare price (per kg or litre), any offer, and a verdict on whether today's price is good compared with the household's price history.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(10) },
    },
    async ({ query, limit }) => {
      const res = await willys.search(query, 0, limit);
      recordSearchResults(store, res.results);
      return text(
        res.results.map((p) => ({
          code: p.code,
          name: p.name,
          brand: p.manufacturer,
          size: p.displayVolume,
          price: p.priceValue,
          comparePrice: p.comparePrice ? `${p.comparePrice}/${p.comparePriceUnit ?? ""}` : null,
          offer: p.potentialPromotions?.[0]
            ? [p.potentialPromotions[0].conditionLabel, p.potentialPromotions[0].rewardLabel, p.potentialPromotions[0].redeemLimitLabel].filter(Boolean).join(" ")
            : null,
          outOfStock: p.outOfStock ?? false,
          priceVerdict: judgePrice(store, p).summary,
        })),
      );
    },
  );

  server.registerTool(
    "current_offers",
    {
      description: "This week's Willys online offers (the ones that apply to a click-and-collect order) at the household's store, from the latest daily snapshot. Filter by a word in the name or brand.",
      inputSchema: { filter: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
    },
    async ({ filter, limit }) => text(store.currentOffers(filter, limit)),
  );

  server.registerTool(
    "price_history",
    { description: "Every price this household has seen for one product.", inputSchema: { productCode: z.string() } },
    async ({ productCode }) => text({ product: store.productName(productCode), history: store.priceHistory(productCode) }),
  );

  return server;
}
