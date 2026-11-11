import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Turn } from "./fake-claude.ts";
import { sampleRecipe } from "../../src/recipes/sample.ts";

// Everything an integration test runs against: the real CLI, database and
// MCP server, with Willys, Resend and Slack replaced by local fakes and
// Claude Code by a scripted stand-in (fake-claude.ts).

const ROOT = new URL("../../", import.meta.url).pathname;
export const HOUSEHOLD = "test";

export interface Product {
  code: string;
  name: string;
  price: number;
  // Shown among this week's online offers.
  offer?: boolean;
  brand?: string;
  // Willys's category names, top first.
  category?: string[];
  // The product page's Innehållsförteckning and labels.
  ingredients?: string;
  labels?: string[];
}

export const CATALOG: Product[] = [
  { code: "CHICKEN_ST", name: "Kycklinglårfilé 700g", price: 67.9, offer: true },
  { code: "BEEF_ST", name: "Nötfärs 500g", price: 59.9, offer: true },
  { code: "BEANS_ST", name: "Kidneybönor 380g", price: 12.9 },
  { code: "RICE_ST", name: "Jasminris 1kg", price: 29.9 },
  { code: "SKYR_ST", name: "Naturell Skyr 400g", price: 18.9 },
  { code: "MILK_ST", name: "Laktosfri mjölk 1,5l", price: 17 },
  { code: "BANANA_ST", name: "Banan", price: 3.98 },
  { code: "KVARG_ST", name: "Vanilj Kvarg 1kg", price: 39.9 },
];

// Willys: products, campaigns, a cart, and click-and-collect slots on the
// pickup day. `failing` makes a path answer with an error.
export class FakeWillys {
  readonly catalog: Product[];
  constructor(catalog: Product[] = CATALOG) {
    this.catalog = catalog;
  }
  readonly cart = new Map<string, number>();
  slotInCart: string | null = null;
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly failing = new Set<string>();
  slots: { code: string; startTime: number; endTime: number; closeTime: number; available: boolean; formattedTime: string; closeTimeFormatted: string }[] = [];
  #server!: Server;
  url = "";

  // Slots on `date` at the given Stockholm times, open for orders.
  setSlots(date: string, times: [string, string][]): void {
    this.slots = times.map(([from, to]) => ({
      code: `TEST_Collect_${date}_${from}`,
      startTime: stockholm(date, from),
      endTime: stockholm(date, to),
      closeTime: stockholm(date, "00:00"),
      available: true,
      formattedTime: `${date} ${from}-${to}`,
      closeTimeFormatted: `the day before, 23:59`,
    }));
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => this.#handle(req, res).catch((err) => send(res, 500, { error: String(err) })));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.#server.close();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    this.calls.push({ method: req.method ?? "GET", path: url.pathname, body });
    if ([...this.failing].some((p) => url.pathname.startsWith(p))) return send(res, 500, { error: "fake failure" });
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/config") return send(res, 200, {}, { "Set-Cookie": "JSESSIONID=test; Path=/" });
    if (route === "GET /axfood/rest/csrf-token") return send(res, 200, "csrf");
    if (route === "POST /login") return send(res, 200, {});
    if (route === "GET /axfood/rest/customer") return send(res, 200, { uid: "test@example.com", name: "Test", storeId: "9999" });
    if (route === "GET /search/clean") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      return send(res, 200, page(this.catalog.filter((p) => words.some((w) => [p.name, p.code, p.brand ?? ""].some((field) => field.toLowerCase().includes(w))))));
    }
    if (route.startsWith("GET /search/campaigns/")) return send(res, 200, page(url.pathname.endsWith("online") ? this.catalog.filter((p) => p.offer) : []));
    if (route.startsWith("GET /axfood/rest/p/")) {
      const p = this.catalog.find((c) => c.code === decodeURIComponent(url.pathname.split("/").pop()!));
      if (!p) return send(res, 404, { error: "no such product" });
      const crumbs = (p.category ?? ["Skafferi"]).map((name, i) => ({ name, categoryCode: `N${i + 1}` }));
      return send(res, 200, { code: p.code, name: p.name, manufacturer: p.brand ?? null, ingredients: p.ingredients ?? "", extendedLabels: (p.labels ?? []).map((name) => ({ name })), breadCrumbs: [{ name: "Alla varor", categoryCode: "N00" }, ...crumbs, { name: p.name, categoryCode: null }] });
    }
    if (route === "GET /axfood/rest/cart") return send(res, 200, this.#cart());
    if (route === "POST /axfood/rest/cart/addProducts") {
      for (const p of (body as { products: { productCodePost: string; qty: number }[] }).products) {
        if (p.qty > 0) this.cart.set(p.productCodePost, p.qty);
        else this.cart.delete(p.productCodePost);
      }
      return send(res, 200, {});
    }
    if (route === "GET /axfood/rest/v2/slot/pickInStore") return send(res, 200, { slots: this.slots, selectedSlot: null, tmsSlots: false });
    if (route.startsWith("POST /axfood/rest/v2/slot/slotInCart/")) {
      this.slotInCart = decodeURIComponent(url.pathname.split("/").pop()!);
      return send(res, 200, {});
    }
    if (route === "GET /axfood/rest/v2/slot/slotInCart") return send(res, 200, this.slots.find((s) => s.code === this.slotInCart) ?? null);
    return send(res, 404, { error: `no fake for ${route}` });
  }

  // Placing the order on willys.se empties the cart and takes the slot.
  placeOrder(): void {
    this.cart.clear();
    this.slotInCart = null;
  }

  #cart() {
    const products = [...this.cart].map(([code, quantity]) => {
      const p = this.catalog.find((c) => c.code === code)!;
      return { code, name: p.name, quantity, totalPrice: kr(p.price * quantity) };
    });
    return { products, totalPrice: kr([...this.cart].reduce((sum, [code, q]) => sum + this.catalog.find((c) => c.code === code)!.price * q, 0)) };
  }
}

// Resend: records sent email and serves received email.
export class FakeResend {
  readonly sent: { from: string; to: string[]; subject: string; text: string; headers: Record<string, string> }[] = [];
  readonly received: Record<string, unknown>[] = [];
  #server!: Server;
  url = "";

  receive(e: { id: string; from: string; subject: string; text: string; authentication?: object | null; to?: string }): void {
    this.received.push({
      id: e.id,
      from: e.from,
      to: [e.to ?? "food@test.example"],
      cc: [],
      subject: e.subject,
      created_at: new Date().toISOString(),
      message_id: `<${e.id}@test.example>`,
      text: e.text,
      html: null,
      headers: {},
      authentication: e.authentication === undefined ? { spf: "pass", dkim: "pass", dmarc: "pass" } : e.authentication,
    });
  }

  async start(): Promise<void> {
    this.#server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = await readBody(req);
      if (req.method === "POST" && url.pathname === "/emails") {
        this.sent.push(body as FakeResend["sent"][number]);
        return send(res, 200, { id: `sent-${this.sent.length}` });
      }
      if (url.pathname === "/emails/receiving") return send(res, 200, { data: [...this.received].reverse(), has_more: false });
      const one = this.received.find((e) => url.pathname === `/emails/receiving/${e.id}`);
      return one ? send(res, 200, one) : send(res, 404, { message: "not found" });
    });
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.#server.close();
  }
}

// What slack-gateway's outbox refuses (its src/protocol.ts): Slack's own
// limits on a message's text and buttons. The stand-in refuses the same, so
// a post that would fail on hermes fails here.
export function gatewayProblems(body: { text?: unknown; buttons?: { action?: string; label?: string; value?: string }[] }): string[] {
  const problems: string[] = [];
  if (typeof body.text !== "string" || !body.text) problems.push("text: empty");
  const buttons = body.buttons ?? [];
  if (buttons.length > 25) problems.push(`buttons: ${buttons.length}, at most 25`);
  for (const b of buttons) {
    if (!b.action || b.action.length > 200) problems.push(`button action: ${JSON.stringify(b.action)}`);
    if (!b.label || b.label.length > 75) problems.push(`button label: ${JSON.stringify(b.label)}`);
    if ((b.value ?? "").length > 2000) problems.push("button value: over 2000 characters");
  }
  return problems;
}

// slack-gateway's outbox socket: records posts and updates, and refuses
// what the real one refuses (gatewayProblems).
export class FakeGateway {
  readonly posts: { path: string; text: string; threadTs?: string; broadcast?: boolean; buttons: { action: string; label?: string; value: string }[]; ts?: string }[] = [];
  readonly refused: string[] = [];
  // When true, every post and update fails as if the gateway were broken.
  failing = false;
  #server!: Server;
  socket = "";

  async start(dir: string): Promise<void> {
    this.socket = join(dir, "gateway.sock");
    this.#server = createServer(async (req, res) => {
      const body = (await readBody(req)) as FakeGateway["posts"][number];
      if (this.failing) return send(res, 500, { error: "gateway down" });
      const problems = req.url === "/post" || req.url === "/update" ? gatewayProblems(body) : [];
      if (problems.length) {
        this.refused.push(...problems);
        return send(res, 400, problems);
      }
      const ts = `${1_800_000_000 + this.posts.length}.000100`;
      this.posts.push({ ...body, path: req.url ?? "", ts: req.url === "/update" ? body.ts : ts });
      send(res, 200, { channel: "C0FOOD", ts });
    });
    await new Promise<void>((r) => this.#server.listen(this.socket, r));
  }

  stop(): void {
    this.#server.close();
  }
}

export interface Env {
  willys: FakeWillys;
  resend: FakeResend;
  gateway: FakeGateway;
  dir: string;
  db: () => DatabaseSync;
  // Runs `wb <args>` like the timers do; stdin for the slack command.
  wb: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  // Sets which units the stand-in systemctl reports as failed.
  failedUnits: (units: string[]) => void;
  // Sets what the stand-in Claude does on its next runs.
  claude: (turns: Turn[]) => void;
  // What the stand-in Claude was asked, run by run.
  claudeLog: () => { turn: number; model: string; system: string; prompt: string; results: { tool: string; error: boolean; text: string }[] }[];
  stop: () => void;
}

export async function setup(opts: { slack?: boolean; meals?: number; rules?: object; plan?: object } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "wb-it-"));
  const households = join(dir, "households");
  const data = join(dir, "data");
  const creds = join(dir, "creds");
  for (const d of [join(households, HOUSEHOLD), data, creds]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(households, HOUSEHOLD, "household.json"),
    JSON.stringify({
      name: "Test household",
      willys: { storeId: "9999", secret: "test-willys" },
      pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" },
      members: [
        { name: "Carin", email: "carin@test.example" },
        { name: "Stephen", email: "stephen@test.example" },
      ],
      mail: { address: "food@test.example", name: "food-bot", secret: "test-resend" },
      ...(opts.slack === false ? {} : { slack: { bot: "food" } }),
      ...(opts.rules ? { rules: opts.rules } : {}),
      plan: { meals: opts.meals ?? 2, portionsPerMeal: 6, people: 2, language: "en", ...opts.plan },
    }),
  );
  writeFileSync(join(households, HOUSEHOLD, "preferences.md"), "# Food preferences\n- Strong flavours.\n");
  writeFileSync(join(creds, "test-resend-key"), "re_test");
  writeFileSync(join(creds, "test-willys-username"), "user");
  writeFileSync(join(creds, "test-willys-password"), "pass");

  const willys = new FakeWillys();
  const resend = new FakeResend();
  const gateway = new FakeGateway();
  await Promise.all([willys.start(), resend.start(), gateway.start(dir)]);
  const script = join(dir, "claude-script.json");
  const log = join(dir, "claude-log.jsonl");
  writeFileSync(script, "[]");
  writeFileSync(log, "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(ROOT, "test/integration/bin")}:${process.env.PATH}`,
    // Every process the test starts sees the same moment (clock.ts).
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${join(ROOT, "test/integration/clock.ts")}`.trim(),
    WILLYS_BOT_TEST_CLOCK: "1",
    WILLYS_BOT_HOUSEHOLD: HOUSEHOLD,
    WILLYS_BOT_HOUSEHOLDS: households,
    WILLYS_BOT_DATA: data,
    CREDENTIALS_DIRECTORY: creds,
    WILLYS_BASE_URL: willys.url,
    WILLYS_MIN_INTERVAL_MS: "0",
    RESEND_API_URL: resend.url,
    SLACK_GATEWAY_SOCKET: opts.slack === false ? join(dir, "no-gateway.sock") : gateway.socket,
    FAKE_CLAUDE_SCRIPT: script,
    FAKE_CLAUDE_LOG: log,
    FAKE_SYSTEMCTL_FAILED: join(dir, "failed-units"),
    MONITOR_UNIT: "",
  };
  return {
    willys,
    resend,
    gateway,
    dir,
    db: () => new DatabaseSync(join(data, HOUSEHOLD, "willys-bot.sqlite")),
    wb: (args, stdin) =>
      new Promise((resolve) => {
        const child = execFile(process.execPath, ["--no-warnings=ExperimentalWarning", join(ROOT, "src/cli.ts"), ...args], { env, timeout: 60_000 }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        );
        child.stdin?.end(stdin ?? "");
      }),
    failedUnits: (units) => writeFileSync(join(dir, "failed-units"), units.join("\n")),
    claude: (turns) => {
      writeFileSync(script, JSON.stringify(turns));
      writeFileSync(`${script}.next`, "0");
    },
    claudeLog: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    stop: () => {
      willys.stop();
      resend.stop();
      gateway.stop();
    },
  };
}

// The next Friday on or after today, in the local time zone, as the
// planner names a week.
export function nextFriday(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A draft the planner's checks accept, for the products in CATALOG.
export function goodDraft(listItemIds: number[] = []) {
  const recipe = sampleRecipe(6);
  return {
    summary: "Two strong, lower calorie dishes built around this week's chicken and mince offers.",
    dishes: [
      { name: "Chicken curry", portions: 6, why: "Thigh fillet on offer", origin: "", recipeId: 0, recipe },
      { name: "Chili con carne", portions: 6, why: "Lean mince", origin: "", recipeId: 0, recipe: sampleRecipe(6, "mince") },
    ],
    lines: [
      { productCode: "CHICKEN_ST", qty: 2, reason: "Curry", dish: 1, listItemIds: [], restocks: "" },
      { productCode: "BEEF_ST", qty: 2, reason: "Chili", dish: 2, listItemIds: [], restocks: "" },
      { productCode: "BEANS_ST", qty: 2, reason: "Chili", dish: 2, listItemIds: [], restocks: "" },
      { productCode: "RICE_ST", qty: 1, reason: "Rice for both", dish: 0, listItemIds: [], restocks: "" },
      ...(listItemIds.length ? [{ productCode: "MILK_ST", qty: 2, reason: "From the list", dish: 0, listItemIds, restocks: "" }] : []),
    ],
    skipped: [],
    notes: "",
  };
}

// The planner looks products up before using them; the stand-in does the
// same so their names and prices are known.
export const SEARCHES = ["kyckling", "nötfärs", "kidney", "jasminris", "mjölk"].map((q) => ({ tool: "search_products", args: { query: q } }));

function stockholm(date: string, time: string): number {
  // Stockholm is UTC+1 in winter and UTC+2 in summer; pick the offset that
  // gives back the wanted local time.
  for (const offset of ["+01:00", "+02:00"]) {
    const ms = Date.parse(`${date}T${time}:00${offset}`);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
    if (local === time) return ms;
  }
  throw new Error(`no Stockholm time ${date} ${time}`);
}

function page(products: Product[]) {
  return {
    results: products.map((p) => ({ code: p.code, name: p.name, manufacturer: p.brand, priceValue: p.price, displayVolume: "", ...(p.offer ? { potentialPromotions: [{ price: p.price, rewardLabel: `${p.price}/st` }] } : {}) })),
    pagination: { pageSize: 100, currentPage: 0, numberOfPages: 1, totalNumberOfResults: products.length },
  };
}

const kr = (n: number) => `${n.toFixed(2).replace(".", ",")} kr`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const c of req) raw += c;
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
