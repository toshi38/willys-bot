import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../core/context.ts";
import { judgePrice, recordSearchResults } from "../core/prices.ts";

// The household's MCP tools: the shared shopping list, product search with a
// price verdict, offers and price history. Nothing here touches the Willys
// cart or places an order; that only happens in the weekly run after an
// approval email.

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export function buildServer(ctx: Context, member: string): McpServer {
  const { store, willys, household } = ctx;
  const server = new McpServer(
    { name: "willys-bot", version: "0.1.0" },
    {
      instructions: `Shared grocery list and Willys price lookup for ${household.config.name}. You are talking to ${member}.
Items added here are bought in the next weekly Willys order, which a household member approves by email.
When someone asks for something, search for matching products, compare the options on price per unit and the price verdict, and suggest one, but let them choose when it is a matter of taste.
If they share a photo of a handwritten list, read it, tell them what you read (flag words you are unsure of), and add the items with list_add once they confirm.
Prices are in SEK. Verdicts compare today's price with what this household has seen before: "great" and "good" are worth stocking up on.`,
    },
  );

  server.registerTool(
    "list_view",
    { description: "Show the open shopping list: items waiting for the next order.", inputSchema: {} },
    async () => text(store.listItems().map(({ id, text: t, quantity, note, productCode, addedBy, addedAt }) => ({ id, text: t, quantity, note, productCode, productName: productCode ? store.productName(productCode) : null, addedBy, addedAt }))),
  );

  server.registerTool(
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

  server.registerTool(
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
    async ({ id, ...patch }) => text(store.updateListItem(id, patch) ?? `No item #${id}`),
  );

  server.registerTool(
    "list_remove",
    { description: "Remove an item from the list.", inputSchema: { id: z.number().int() } },
    async ({ id }) => text(store.updateListItem(id, { status: "removed" }) ?? `No item #${id}`),
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
      description: "This week's Willys offers at the household's store, from the latest daily snapshot. Filter by a word in the name or brand.",
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
