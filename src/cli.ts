import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { openContext, type Context } from "./core/context.ts";
import { householdId } from "./core/household.ts";
import { judgePrice, recordSearchResults, snapshotCampaigns } from "./core/prices.ts";
import { sendToMembers } from "./notify/email.ts";
import { handleInbox } from "./plan/inbox.ts";
import { handleSlack, type SlackRequest } from "./plan/slack.ts";
import { apply, planWeek, redraftWeek, renderWeek } from "./plan/weekly.ts";

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
  plan [--dry-run]        draft the shop for the next pickup and send it, unless that week exists
                          (--dry-run prints the draft without saving; --feedback adds instructions)
  redraft <text...>       replace the open week's dishes, keeping requests
  week [<pickup-date>]    show a week's shop (default: the open week)
  inbox [--dry-run]       act on new email to the bot (--dry-run lists it without acting)
  slack                   handle one slack-gateway request (JSON on stdin, response JSON on stdout)
  apply <pickup-date>     fill the cart and book a slot for a week without waiting for a reply
  weeks                   list recent weeks and their status
  alert <unit>            email the operator that a systemd unit failed, with its last log lines
                          (at most once every six hours per unit; run by OnFailure=)`;

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
      force: { type: "boolean" },
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
        const item = store.updateListItem(Number(args[0]), { status: "removed" }, "cli");
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
        console.log(store.removePantryItem(name, "cli") ? `Removed ${name}` : `No pantry entry ${name}`);
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
      console.log((await planWeek(ctx, { dryRun: values["dry-run"] === true, instructions: values.feedback as string | undefined })).message);
      return;
    }
    case "redraft": {
      const week = store.openWeek();
      if (!week) throw new Error("No week is open");
      console.log((await redraftWeek(ctx, week, rest.join(" "), "cli")).message);
      return;
    }
    case "week": {
      const week = rest[0] ? store.week(rest[0]) : store.openWeek();
      if (!week) throw new Error(rest[0] ? `No week ${rest[0]}` : "No week is open");
      console.log(`Week ${week.id} (${week.status}, version ${week.version})\n\n${renderWeek(ctx, week)}`);
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
      const week = store.week(rest[0] ?? "");
      if (!week) throw new Error(`No week ${rest[0]}`);
      // apply adds to the cart, so filling it twice doubles every line.
      if (week.status !== "open" && !(week.status === "failed" && values.force)) {
        throw new Error(`Week ${week.id} is ${week.status}. A failed week may be partly in the cart already: check willys.se, then pass --force to fill it again.`);
      }
      console.log(await apply(ctx, week, { dryRun: values["dry-run"] === true }));
      return;
    }
    case "alert": {
      const unit = rest[0] ?? process.env.MONITOR_UNIT;
      if (!unit) throw new Error("alert needs the failed unit's name");
      const key = `alert.${unit}`;
      const last = store.get(key);
      if (last && Date.now() - new Date(last).getTime() < 6 * 3_600_000) {
        console.log(`Already alerted about ${unit} at ${last}`);
        return;
      }
      let log = "";
      try {
        log = execFileSync("journalctl", ["--user", "-u", unit, "-n", "30", "--no-pager", "-o", "short-iso"], { encoding: "utf8" });
      } catch {
        log = "(could not read the journal)";
      }
      const operator = household.config.operator ?? household.config.members[0].email;
      await sendToMembers(household, {
        to: [operator],
        subject: `food-bot: ${unit} failed`,
        markdown: `${unit} failed on ${hostname()}. Its last log lines:\n\n\`\`\`\n${log.trim()}\n\`\`\`\n\nYou get this at most once every six hours for this unit.`,
      });
      store.set(key, new Date().toISOString());
      console.log(`Alerted ${operator} about ${unit}`);
      return;
    }
    case "weeks": {
      for (const w of store.weeks()) {
        console.log(`${w.id} ${w.status.padEnd(8)} ${store.dishes(w.id).length} dishes, ${store.items(w.id).length} items${w.decidedBy ? `, by ${w.decidedBy}` : ""}${w.error ? `, error: ${w.error}` : ""}`);
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
