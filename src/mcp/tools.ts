import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../core/context.ts";
import { judgePrice, recordSearchResults } from "../core/prices.ts";
import { picksDishes, savePreferences } from "../core/household.ts";
import { brokenRule, glutenRisk, needsCategory, productFacts, ruleProblems, type ProductFacts } from "../core/rules.ts";
import { dishRecipeId, dishRecipeProblems } from "../plan/planner.ts";
import { editable, localDate } from "../plan/week.ts";
import { Recipe } from "../recipes/recipe.ts";
import type { PantryStatus, Store, Week, WeekStatus } from "../core/store.ts";

// The household's MCP tools: the shared shopping list, the pantry, product
// search with a price verdict, offers and price history. Nothing here touches the Willys
// cart or places an order; that only happens in the weekly run after an
// approval email.

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const PREFERENCES_HISTORY = "preferences.history";

// A week that was approved has been, or is being, bought.
const ORDERED: WeekStatus[] = ["approved", "applied"];

// The household's ordered weeks, newest first.
export function orderedWeeks(store: Store, limit: number): Week[] {
  return store.weeks(limit * 3).filter((w) => ORDERED.includes(w.status)).slice(0, limit);
}

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

  // This week's shop: its dishes and items, edited one at a time so nothing
  // else changes. A week can change while it waits for a decision and,
  // once approved, until pickup. With `week` set (the week a message is
  // about), the tools only touch that week; otherwise the current one.
  const openWeek = () => {
    const w = week ? store.week(week) : store.currentWeek(localDate(new Date()));
    if (!w) throw new Error("No week is planned for the next pickup yet.");
    if (!editable(w)) throw new Error(`The week for pickup ${w.id} is ${w.status}, so it cannot be changed.`);
    return w;
  };
  // One server serves one message (see core/claude.ts).
  let dishesRemoved = 0;
  const weekView = () => {
    const w = openWeek();
    return {
      week: { pickup: w.id, status: w.status, summary: w.summary, notes: w.notes },
      dishes: store.dishes(w.id).map((d, i) => ({
        number: i + 1, id: d.id, name: d.name, portions: d.portions, why: d.why, recipeId: d.recipeId,
        ...(d.origin ? { wildcardFrom: d.origin } : {}),
        ...(picksDishes(household) ? { picked: d.pickedBy !== null || d.addedBy !== "planner" } : {}),
      })),
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
        "Add a product to this week's shop. Without dishId it is a request from the person you are talking to, and stays until a member removes it. With dishId it is an ingredient of that dish. Find the productCode with search_products first. Products of an avoided brand, or that look like they contain gluten, are refused unless the reason starts with \"Brand exception:\" or \"Gluten checked:\" and says why.",
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
      const problems = ruleProblems(household, (await productFacts(ctx, productCode))!, reason);
      if (problems.length) throw new Error(problems.join(" "));
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
        "Add a dish to this week's shop, with its recipe, or reuse a known recipe that has steps by recipeId. Then add its ingredients with week_add_item and the dish's id. To swap a dish, dish_remove the old one first. The recipe is the whole meal (rice, potatoes, a salad served with it are ingredients with steps that make them), in steps ordered so the cook is never idle while something cooks; it is checked, and a recipe with problems is sent back with what to fix.",
      inputSchema: {
        name: z.string().min(1),
        portions: z.number().int().min(1),
        why: z.string().describe("Why this dish: offers used, flavour, protein, or what the member asked for"),
        recipeId: z.number().int().optional().describe("A known recipe to reuse as it is"),
        recipe: Recipe.optional().describe("The recipe, for the dish's portions; needed without recipeId"),
      },
    },
    async ({ name, portions, why, recipeId, recipe }) => {
      const w = openWeek();
      const dish = { name, portions, recipeId, recipe };
      const problems = dishRecipeProblems(ctx, dish);
      if (problems.length) throw new Error(`Fix the recipe and call dish_add again:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      return text(store.addDish(w.id, { name, portions, why, recipeId: dishRecipeId(ctx, dish, member) }, member));
    },
  );

  if (!readOnly) server.registerTool(
    "dish_remove",
    {
      description: "Remove a dish from this week's shop, with the ingredients bought for it. Requests stay. One dish per message: for several or all new dishes, ask for a redraft instead.",
      inputSchema: { dishId: z.number().int() },
    },
    async ({ dishId }) => {
      const w = openWeek();
      if (store.dish(dishId)?.weekId !== w.id) throw new Error(`Dish ${dishId} is not in this week`);
      // Removing several dishes by hand loses the planner's checks; a
      // redraft keeps them.
      if (dishesRemoved >= 1) throw new Error("Only one dish can be removed per message. For several or all new dishes, put instructions in redraft instead, and do not remove any more dishes.");
      store.removeDish(dishId, member);
      dishesRemoved++;
      return text(weekView());
    },
  );

  if (!readOnly) server.registerTool(
    "dish_pick",
    {
      description:
        "Pick dishes the household wants to cook this week, or unpick them. When the week has more suggestions than the household cooks, only picked dishes are ordered. Changes only the dishes you name.",
      inputSchema: { dishIds: z.array(z.number().int()).min(1), picked: z.boolean().default(true) },
    },
    async ({ dishIds, picked }) => {
      const w = openWeek();
      if (w.status !== "open") throw new Error(`The week for pickup ${w.id} is already ${w.status}: its dishes were picked when it was ordered.`);
      if (!picksDishes(household)) throw new Error("This household orders every dish; there is nothing to pick.");
      for (const id of dishIds) if (store.dish(id)?.weekId !== w.id || store.dish(id)?.removedAt) throw new Error(`Dish ${id} is not in this week`);
      for (const id of dishIds) store.pickDish(id, picked, member);
      return text(weekView());
    },
  );

  if (!readOnly) server.registerTool(
    "dish_rate",
    {
      description:
        "Record how a dish the household cooked was: 1 to 5 stars and what they said about it. Use the dish id from Recent weeks or week_view. Rating again replaces the person's earlier rating of that dish. The planner suggests more of what is rated highly and drops what is rated 2 or less.",
      inputSchema: {
        dishId: z.number().int(),
        stars: z.number().int().min(1).max(5),
        comment: z.string().optional().describe("Their words about it, short"),
      },
    },
    async ({ dishId, stars, comment }) => {
      const d = store.dish(dishId);
      const w = d ? store.week(d.weekId) : null;
      if (!d || d.removedAt || !w || !ORDERED.includes(w.status)) throw new Error(`Dish ${dishId} is not a dish the household ordered`);
      return text(store.rateDish(dishId, member, stars, comment));
    },
  );

  server.registerTool(
    "recipe_view",
    {
      description: "Read a recipe by id, or search the household's recipes by name.",
      inputSchema: { id: z.number().int().optional(), search: z.string().optional() },
    },
    async ({ id, search }) => {
      const ratings = new Map(store.recipeRatings().map((r) => [r.recipeId, { average: r.average, count: r.count, comments: r.comments }]));
      if (id !== undefined) {
        const r = store.recipe(id);
        return text(r ? { ...r, ...(ratings.has(id) ? { ratings: ratings.get(id) } : {}) } : `No recipe ${id}`);
      }
      return text(store.recipes(search).map((r) => ({ id: r.id, name: r.name, servings: r.servings, ...(ratings.has(r.id) ? { rated: ratings.get(r.id)!.average } : {}) })));
    },
  );

  // Weeks that were ordered, newest first, for "what did we buy" and "what
  // were the recipes" once the week's pickup has passed and week_view no
  // longer reaches it.
  server.registerTool(
    "past_weeks",
    {
      description:
        "Weeks the household has ordered, newest first, with their dishes. Give a pickup date (YYYY-MM-DD) for one week in full: each dish's recipe and the items ordered. Use this when someone asks about food they already bought or how to cook it.",
      inputSchema: {
        pickup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).max(20).default(6),
      },
    },
    async ({ pickup, limit }) => {
      if (pickup) {
        const w = store.week(pickup);
        if (!w || !ORDERED.includes(w.status)) return text(`No ordered week for pickup ${pickup}`);
        return text({
          pickup: w.id,
          status: w.status,
          summary: w.summary,
          dishes: store.dishes(w.id).map((d) => {
            const r = d.recipeId ? store.recipe(d.recipeId) : null;
            const ratings = store.dishRatings(d.id).map((x) => ({ member: x.member, stars: x.stars, comment: x.comment }));
            return { id: d.id, name: d.name, portions: d.portions, ...(ratings.length ? { ratings } : {}), recipe: r && { id: r.id, servings: r.servings, ingredients: r.ingredients, method: r.method, notes: r.notes } };
          }),
          items: store.items(w.id).map((i) => ({ qty: i.qty, product: i.name ?? i.productCode, dishId: i.dishId })),
        });
      }
      return text(orderedWeeks(store, limit).map((w) => ({ pickup: w.id, status: w.status, dishes: store.dishes(w.id).map((d) => ({ name: d.name, portions: d.portions, recipeId: d.recipeId })) })));
    },
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
      // Products the household's rules flag come last, marked, so the model
      // sees the alternatives first. Categories are looked up only for the
      // few products a category rule could apply to.
      const facts = new Map<string, ProductFacts>();
      let lookups = 0;
      for (const p of res.results) {
        const known: ProductFacts = { code: p.code, name: p.name, brand: p.manufacturer ?? store.productBrand(p.code), category: store.productCategory(p.code) ?? undefined };
        facts.set(p.code, needsCategory(household, known) && lookups++ < 5 ? ((await productFacts(ctx, p.code).catch(() => null)) ?? known) : known);
      }
      const avoid = (code: string) => {
        const rule = brokenRule(household, facts.get(code)!);
        return rule ? [rule.brand, rule.name, rule.category && `in ${rule.category}`, rule.product].filter(Boolean).join(" ") : null;
      };
      const flagged = (p: (typeof res.results)[number]) => !!avoid(p.code) || !!glutenRisk(household, p.name);
      return text(
        [...res.results].sort((a, b) => Number(flagged(a)) - Number(flagged(b))).map((p) => ({
          code: p.code,
          name: p.name,
          brand: p.manufacturer,
          ...(avoid(p.code) ? { avoid: avoid(p.code) } : {}),
          ...(glutenRisk(household, p.name) ? { mayContainGluten: true } : {}),
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
    "product_info",
    {
      description:
        "What a Willys product is made of, from its product page: the ingredient list (Innehållsförteckning, allergens in capitals), labels such as \"Sånär Fri Från Gluten\" or \"Det överkorsade axet\", diet and origin. Use it to check a product against an allergy or celiac disease before buying it or answering about it. ingredients is null when Willys lists none.",
      inputSchema: { productCode: z.string().min(1) },
    },
    async ({ productCode }) => text(await willys.productInfo(productCode)),
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
