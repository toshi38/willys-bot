import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { openContext } from "../core/context.ts";
import { householdId, memberByLogin } from "../core/household.ts";
import type { PantryStatus } from "../core/store.ts";
import { decide, propose } from "../plan/weekly.ts";
import { homePage, listPage, offersPage, page, pantryPage, planDetail, plansTable, productPage } from "./views.ts";

// The household's web UI: plans and past menus, the shopping list, the
// pantry, offers and price history. It listens on localhost only and is
// published on the tailnet with `tailscale serve`, which adds the
// Tailscale-User-Login header; that login must belong to a household member.
// --dev-member skips the header for local development.

const { values } = parseArgs({
  options: {
    household: { type: "string" },
    port: { type: "string", default: "8787" },
    "dev-member": { type: "string" },
  },
});

const ctx = openContext(householdId(values.household));
const { store, household } = ctx;

// Plan making and cart filling take a minute or more, so they run in the
// background, one at a time; the page says so until they finish.
let job: { label: string; planId: string | null } | null = null;
let lastResult: string | null = null;

// Starts a job unless one is already running; the page shows the running
// job either way.
function runJob(label: string, planId: string | null, work: () => Promise<string[] | unknown>): void {
  if (job) return;
  job = { label, planId };
  work()
    .then((r) => (lastResult = Array.isArray(r) ? r.join(". ") : `${label}: done`))
    .catch((err: unknown) => (lastResult = `${label} failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => (job = null));
}

function identify(req: IncomingMessage): string | null {
  const dev = values["dev-member"];
  if (dev) return dev;
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string") return null;
  return memberByLogin(household, login)?.name ?? null;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Form too large");
  }
  return new URLSearchParams(body);
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
  res.end(html);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { Location: to });
  res.end();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const member = identify(req);
  if (!member) return send(res, 403, "<p>Not a member of this household.</p>");
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const flash = job ? `Working: ${job.label}. Refresh in a minute.` : lastResult;
  const opts = (active: string) => ({ household, member, active, flash });

  if (req.method === "POST") {
    // Forms only ever post from these pages; refuse cross-site posts.
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((site && site !== "same-origin") || (origin && new URL(origin).host !== req.headers.host)) {
      return send(res, 403, "<p>Cross-site request refused.</p>");
    }
    const form = await readForm(req);
    lastResult = null;

    if (path === "/list/add") {
      const text = form.get("text")?.trim();
      if (text) store.addListItem({ text, quantity: form.get("quantity")?.trim() || null, note: form.get("note")?.trim() || null, addedBy: member });
      return redirect(res, "/list");
    }
    const listRemove = path.match(/^\/list\/(\d+)\/remove$/);
    if (listRemove) {
      store.updateListItem(Number(listRemove[1]), { status: "removed" }, member);
      return redirect(res, "/list");
    }
    if (path === "/pantry/set") {
      const name = form.get("name")?.trim();
      const status = form.get("status") ?? "have";
      if (name && ["have", "low", "out"].includes(status)) {
        store.setPantryItem({ name, status: status as PantryStatus, ...(form.has("quantity") ? { quantity: form.get("quantity")?.trim() || null } : {}), updatedBy: member });
      }
      return redirect(res, "/pantry");
    }
    if (path === "/pantry/remove") {
      store.removePantryItem(form.get("name") ?? "", member);
      return redirect(res, "/pantry");
    }
    if (path === "/plans/new") {
      runJob("making a new plan", null, async () => [`New plan ${(await propose(ctx)).id} sent`]);
      return redirect(res, "/");
    }
    const action = path.match(/^\/plans\/([\w-]+)\/(approve|reject|change)$/);
    if (action) {
      const plan = store.plan(action[1]);
      if (!plan) return send(res, 404, page(opts("/plans"), "Not found", "<p>No such plan.</p>"));
      const decision =
        action[2] === "approve" ? { kind: "approve" as const }
        : action[2] === "reject" ? { kind: "reject" as const }
        : { kind: "change" as const, feedback: form.get("feedback")?.trim() ?? "" };
      if (decision.kind === "change" && !decision.feedback) return redirect(res, `/plans/${plan.id}`);
      const label = decision.kind === "approve" ? "filling the cart and booking a slot" : decision.kind === "reject" ? "skipping this week" : "making a revised plan";
      runJob(label, plan.id, () => decide(ctx, plan, decision, member));
      return redirect(res, `/plans/${plan.id}`);
    }
    return send(res, 404, page(opts(""), "Not found", "<p>Not found.</p>"));
  }

  if (path === "/") {
    const recent = store.plans(["sent", "approved", "applied", "rejected", "failed"]);
    return send(res, 200, page(opts("/"), "Home", homePage(recent[0] ?? null, recent.slice(1, 8), store.listItems(), store.pantryItems())));
  }
  if (path === "/plans") {
    return send(res, 200, page(opts("/plans"), "Plans", `<h1>Plans and menus</h1>${plansTable(store.plans(["draft", "sent", "approved", "applied", "rejected", "failed"]))}`));
  }
  const planMatch = path.match(/^\/plans\/([\w-]+)$/);
  if (planMatch) {
    const plan = store.plan(planMatch[1]);
    if (!plan) return send(res, 404, page(opts("/plans"), "Not found", "<p>No such plan.</p>"));
    return send(res, 200, page(opts("/plans"), "Plan", planDetail(plan, job?.planId === plan.id)));
  }
  if (path === "/list") return send(res, 200, page(opts("/list"), "List", listPage(store.listItems(), (c) => store.productName(c))));
  if (path === "/pantry") return send(res, 200, page(opts("/pantry"), "Pantry", pantryPage(store.pantryItems())));
  if (path === "/offers") {
    const q = url.searchParams.get("q") ?? "";
    return send(res, 200, page(opts("/offers"), "Offers", offersPage(q, store.currentOffers(q, 300))));
  }
  const product = path.match(/^\/product\/([^/]+)$/);
  if (product) {
    const code = decodeURIComponent(product[1]);
    return send(res, 200, page(opts("/offers"), "Price history", productPage(code, store.productName(code), store.priceHistory(code))));
  }
  return send(res, 404, page(opts(""), "Not found", "<p>Not found.</p>"));
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, `<p>Something went wrong: ${String(err instanceof Error ? err.message : err).replace(/</g, "&lt;")}</p>`);
  });
});
server.listen(Number(values.port), "127.0.0.1", () => console.log(`food-bot web UI on http://127.0.0.1:${values.port} for ${household.config.name}`));

const shutdown = () => server.close(() => {
  ctx.close();
  process.exit(0);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
