import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { openContext } from "../core/context.ts";
import { householdId, memberByLogin } from "../core/household.ts";
import type { PantryStatus, Week } from "../core/store.ts";
import { runIntake } from "../plan/inbox.ts";
import { announceChanges, decide, planWeek, redraftWeek } from "../plan/weekly.ts";
import { homePage, listPage, offersPage, page, pantryPage, productPage, weekDetail, weeksTable, type WeekView } from "./views.ts";

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
let job: { label: string; weekId: string | null } | null = null;
let lastResult: string | null = null;

// Starts a job unless one is already running; the page shows the running
// job either way.
function runJob(label: string, weekId: string | null, work: () => Promise<string[] | string | unknown>): void {
  if (job) return;
  job = { label, weekId };
  work()
    .then((r) => (lastResult = Array.isArray(r) ? r.join(". ") : typeof r === "string" ? r : `${label}: done`))
    .catch((err: unknown) => (lastResult = `${label} failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => (job = null));
}

function view(week: Week): WeekView {
  const dishes = store.dishes(week.id);
  const recipes = new Map(dishes.map((d) => (d.recipeId ? store.recipe(d.recipeId) : null)).filter((r) => r !== null).map((r) => [r.id, r] as const));
  return { week, dishes, items: store.items(week.id), recipes };
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
      runJob("planning the next pickup", null, async () => (await planWeek(ctx)).message);
      return redirect(res, "/");
    }
    const action = path.match(/^\/plans\/([\w-]+)\/(approve|reject|change)$/);
    if (action) {
      const week = store.week(action[1]);
      if (!week) return send(res, 404, page(opts("/plans"), "Not found", "<p>No such week.</p>"));
      const by = household.config.members.find((m) => m.name === member)?.email ?? member;
      if (action[2] === "change") {
        const text = form.get("feedback")?.trim() ?? "";
        if (!text) return redirect(res, `/plans/${week.id}`);
        runJob("making the change", week.id, async () => {
          const outcome = await runIntake(ctx, { name: member, via: "web", subject: "", text, week, thread: [] });
          if (outcome.redraft) {
            const result = await redraftWeek(ctx, week, outcome.redraft, by);
            if (!result.done) return `${outcome.reply} (I could not start new dishes: ${result.message}.)`;
          } else {
            await announceChanges(ctx, week.id);
          }
          return outcome.reply || outcome.summary;
        });
        return redirect(res, `/plans/${week.id}`);
      }
      const kind = action[2] === "approve" ? "approve" : "skip";
      runJob(kind === "approve" ? "filling the cart and booking a slot" : "skipping this week", week.id, () => decide(ctx, week, kind, by));
      return redirect(res, `/plans/${week.id}`);
    }
    return send(res, 404, page(opts(""), "Not found", "<p>Not found.</p>"));
  }

  if (path === "/") {
    const recent = store.weeks(8).map(view);
    return send(res, 200, page(opts("/"), "Home", homePage(recent[0] ?? null, recent.slice(1), store.listItems(), store.pantryItems())));
  }
  if (path === "/plans") {
    return send(res, 200, page(opts("/plans"), "Plans", `<h1>Plans and menus</h1>${weeksTable(store.weeks(52).map(view))}`));
  }
  const planMatch = path.match(/^\/plans\/([\w-]+)$/);
  if (planMatch) {
    const week = store.week(planMatch[1]);
    if (!week) return send(res, 404, page(opts("/plans"), "Not found", "<p>No such week.</p>"));
    return send(res, 200, page(opts("/plans"), "Plan", weekDetail(view(week), job?.weekId === week.id)));
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
