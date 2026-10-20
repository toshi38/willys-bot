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
export function buildServer(ctx: Context, member: string, { readOnly = false } = {}): McpServer {
  const { store, willys, household } = ctx;
  const server = new McpServer(
    { name: "willys-bot", version: "0.1.0" },
    {
      instructions: `Shared grocery list and Willys price lookup for ${household.config.name}. You are talking to ${member}.
Items added here are bought in the next weekly Willys order, which a household member approves by email.
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
