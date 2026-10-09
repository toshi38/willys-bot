import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../core/context.ts";
import type { PlanLine } from "../core/store.ts";

// The weekly plan, made by headless Claude Code (`claude -p`) on the
// operator's Claude subscription. Claude gets the household's preferences,
// the open shopping list and this week's offers, and can search Willys and
// read price history through this project's MCP server in read-only mode.
// It returns a menu and the exact products and quantities to buy; nothing
// is put in the cart until a member approves the plan by email.

export interface Plan {
  summary: string;
  dinners: Array<{ day: string; dish: string; why: string }>;
  lines: Array<{ productCode: string; qty: number; reason: string; listItemIds: number[] }>;
  skipped: Array<{ listItemId: number; reason: string }>;
  notes: string;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences on the week: what is on sale, what changed from usual." },
    dinners: {
      type: "array",
      items: {
        type: "object",
        properties: { day: { type: "string" }, dish: { type: "string" }, why: { type: "string" } },
        required: ["day", "dish", "why"],
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
        },
        required: ["productCode", "qty", "reason", "listItemIds"],
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
  required: ["summary", "dinners", "lines", "skipped", "notes"],
};

const SYSTEM_PROMPT = `You do the weekly grocery shop for a household at Willys, a Swedish discount supermarket. You plan the dinners and pick the exact products to order for click-and-collect.

Work like a careful, thrifty person who knows this household:
- Follow the household's preferences closely. They override your own ideas.
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
  const offers = store.currentOffers(undefined, 400);
  const lines = [
    `Household: ${c.name}. ${c.plan.people} people. Plan ${c.plan.dinners} dinners.${c.plan.budgetSek ? ` Budget about ${c.plan.budgetSek} kr.` : ""} Language: ${c.plan.language === "sv" ? "Swedish" : "English"}.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "## Preferences",
    household.preferences || "(none written yet)",
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
  const mcpConfig = join(ctx.store.dir, "planner-mcp.json");
  const root = new URL("../../", import.meta.url).pathname;
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        willys: {
          type: "stdio",
          command: process.execPath,
          args: ["--no-warnings=ExperimentalWarning", join(root, "src/mcp/server.ts"), "--household", ctx.household.id, "--member", "planner", "--read-only"],
          env: { ...(process.env.WILLYS_BOT_DATA ? { WILLYS_BOT_DATA: process.env.WILLYS_BOT_DATA } : {}), ...(process.env.WILLYS_BOT_HOUSEHOLDS ? { WILLYS_BOT_HOUSEHOLDS: process.env.WILLYS_BOT_HOUSEHOLDS } : {}) },
        },
      },
    }),
  );
  const tools = ["search_products", "current_offers", "price_history", "list_view"].map((t) => `mcp__willys__${t}`);
  const plan = (await runClaude(buildPrompt(ctx, feedback), [
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", tools.join(","),
  ])) as Plan;
  return plan;
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
    lines.push({ productCode: l.productCode, name, qty: l.qty, unitPrice: price, reason: l.reason, listItemIds: l.listItemIds });
  }
  return { lines, unknown };
}

function runClaude(prompt: string, extraArgs: string[]): Promise<unknown> {
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--setting-sources", "",
    "--model", process.env.WILLYS_BOT_MODEL ?? "sonnet",
    "--system-prompt", SYSTEM_PROMPT,
    "--json-schema", JSON.stringify(PLAN_SCHEMA),
    ...extraArgs,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: string };
        if (out.is_error || code !== 0) return reject(new Error(`claude exited ${code}: ${out.result ?? stderr}`));
        if (out.structured_output === undefined) return reject(new Error("claude returned no structured output"));
        resolve(out.structured_output);
      } catch {
        reject(new Error(`claude exited ${code} with unparseable output: ${(stderr || stdout).slice(0, 500)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
