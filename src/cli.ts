import { parseArgs } from "node:util";
import { openContext, type Context } from "./core/context.ts";
import { householdId } from "./core/household.ts";
import { judgePrice, recordSearchResults, snapshotCampaigns } from "./core/prices.ts";
import { handleInbox } from "./plan/inbox.ts";
import { handleSlack, type SlackRequest } from "./plan/slack.ts";
import { apply, propose } from "./plan/weekly.ts";

const USAGE = `Usage: npm run wb -- <command> [--household <id>]

  whoami                  log in (or reuse the saved session) and show the account
  snapshot                record today's online and in-store offers for the price history
  search <query>          search products, with a price verdict for each
  list                    show the open shopping list
  list add <text...>      add an item (--qty, --note)
  list remove <id>        remove an item
  pantry                  show the pantry
  pantry set <name...>    add or update a pantry entry (--status have|low|out, --qty, --note)
  pantry remove <name...> stop tracking a pantry entry
  cart                    show the Willys cart
  slots                   show pickup slots for the household's store
  get <path>              GET a willys.se API path and print the JSON (exploration)
  plan [--dry-run]        make this week's plan and email it to the members (--dry-run prints it)
  inbox [--dry-run]       act on new email to the bot (--dry-run lists it without acting)
  slack                   handle one slack-gateway request (JSON on stdin, response JSON on stdout)
  apply <plan-id>         fill the cart and book a slot for a plan without waiting for a reply
  plans                   list recent plans and their status`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      household: { type: "string" },
      qty: { type: "string" },
      note: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
      status: { type: "string" },
      feedback: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const ctx = openContext(householdId(values.household));
  try {
    await run(ctx, command, rest, values);
  } finally {
    ctx.close();
  }
}

async function run(ctx: Context, command: string, rest: string[], values: Record<string, string | boolean | undefined>): Promise<void> {
  const { store, willys, household } = ctx;
  switch (command) {
    case "whoami": {
      const c = await ctx.ensureLogin();
      console.log(`${c.name ?? c.uid} (store ${c.storeId ?? "?"}, home store ${c.homeStoreId ?? "?"})`);
      return;
    }
    case "snapshot": {
      const counts = await snapshotCampaigns(willys, store, household.config.willys.storeId);
      console.log(`Recorded ${counts.online} online and ${counts.offline} in-store offers`);
      return;
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new Error("search needs a query");
      const res = await willys.search(query, 0, Number(values.limit ?? 10));
      recordSearchResults(store, res.results);
      for (const p of res.results) {
        const v = judgePrice(store, p);
        console.log(`${p.code.padEnd(14)} ${p.name} ${p.displayVolume ?? ""} [${p.manufacturer ?? ""}]\n${" ".repeat(15)}${v.summary}`);
      }
      return;
    }
    case "list": {
      const [sub, ...args] = rest;
      if (sub === "add") {
        const item = store.addListItem({ text: args.join(" "), quantity: (values.qty as string) ?? null, note: (values.note as string) ?? null, addedBy: "cli" });
        console.log(`Added #${item.id} ${item.text}`);
      } else if (sub === "remove") {
        const item = store.updateListItem(Number(args[0]), { status: "removed" });
        console.log(item ? `Removed #${item.id} ${item.text}` : "No such item");
      } else {
        for (const i of store.listItems()) console.log(`#${i.id} ${i.text}${i.quantity ? ` x ${i.quantity}` : ""}${i.note ? ` (${i.note})` : ""} [${i.addedBy}]`);
      }
      return;
    }
    case "pantry": {
      const [sub, ...args] = rest;
      const name = args.join(" ");
      if (sub === "set") {
        const status = (values.status as string | undefined) ?? "have";
        if (!["have", "low", "out"].includes(status)) throw new Error("--status must be have, low or out");
        const item = store.setPantryItem({ name, status: status as "have" | "low" | "out", quantity: values.qty as string | undefined, note: values.note as string | undefined, updatedBy: "cli" });
        console.log(`${item.name}: ${item.status}`);
      } else if (sub === "remove") {
        console.log(store.removePantryItem(name) ? `Removed ${name}` : `No pantry entry ${name}`);
      } else {
        for (const p of store.pantryItems()) console.log(`${p.name}: ${p.status}${p.quantity ? `, ${p.quantity}` : ""}${p.note ? ` (${p.note})` : ""}`);
      }
      return;
    }
    case "cart": {
      await ctx.ensureLogin();
      const cart = await willys.cart();
      for (const p of cart.products) console.log(`${p.code.padEnd(14)} ${p.quantity} x ${p.name} ${p.displayVolume ?? ""} ${p.totalPrice ?? ""}`);
      console.log(`Total ${cart.totalPrice ?? "?"}`);
      return;
    }
    case "slots": {
      await ctx.ensureLogin();
      console.log(JSON.stringify(await willys.pickupSlots(household.config.willys.storeId), null, 2));
      return;
    }
    case "get": {
      const path = rest[0];
      if (!path?.startsWith("/")) throw new Error("get needs a path starting with /");
      await ctx.ensureLogin();
      console.log(JSON.stringify(await willys.json(path), null, 2));
      return;
    }
    case "plan": {
      const row = await propose(ctx, { dryRun: values["dry-run"] === true, feedback: values.feedback as string | undefined });
      console.log(`Plan ${row.id} ${values["dry-run"] ? "drafted" : "sent"}`);
      return;
    }
    case "slack": {
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      console.log(JSON.stringify(await handleSlack(ctx, JSON.parse(raw) as SlackRequest)));
      return;
    }
    case "inbox": {
      for (const line of await handleInbox(ctx, { dryRun: values["dry-run"] === true })) console.log(line);
      return;
    }
    case "apply": {
      const plan = store.plan(rest[0] ?? "");
      if (!plan) throw new Error(`No plan ${rest[0]}`);
      console.log(await apply(ctx, plan, { dryRun: values["dry-run"] === true }));
      return;
    }
    case "plans": {
      for (const p of store.plans(["draft", "sent", "approved", "rejected", "applied", "failed"]).slice(0, 20)) {
        console.log(`${p.id} ${p.status.padEnd(8)} ${p.lines.length} lines${p.decidedBy ? `, by ${p.decidedBy}` : ""}${p.error ? `, error: ${p.error}` : ""}${p.decisionNote ? `, note: ${p.decisionNote.slice(0, 60)}` : ""}`);
      }
      return;
    }
    default:
      throw new Error(`Unknown command ${command}\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
