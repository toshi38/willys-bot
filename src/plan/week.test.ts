import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { nextPickup, postChanges, postToWeek } from "./week.ts";

const household = {
  id: "test",
  dir: "/nonexistent",
  preferences: "",
  config: {
    name: "Test",
    members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }],
    pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" },
    mail: { address: "food@ai.lau.engineering", name: "food-bot", secret: "test" },
    slack: { bot: "food" },
  },
} as unknown as Household;

async function fakeGateway(t: { after: (f: () => void) => void }) {
  const posts: Record<string, unknown>[] = [];
  const path = join(mkdtempSync(join(tmpdir(), "gw-")), "s.sock");
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    posts.push(JSON.parse(raw));
    res.end(JSON.stringify({ channel: "C0FOOD", ts: `9.${posts.length}` }));
  });
  await new Promise<void>((r) => server.listen(path, r));
  process.env.SLACK_GATEWAY_SOCKET = path;
  t.after(() => {
    server.close();
    delete process.env.SLACK_GATEWAY_SOCKET;
  });
  return posts;
}

test("the shop runs to the next pickup, and after Friday's window it is next week's", () => {
  const day = (s: string) => nextPickup(household, new Date(s)).toDateString();
  assert.equal(day("2026-10-20T10:00:00"), new Date("2026-10-23T00:00:00").toDateString()); // Tuesday
  assert.equal(day("2026-10-23T19:59:00"), new Date("2026-10-23T00:00:00").toDateString()); // Friday, window open
  assert.equal(day("2026-10-23T20:00:00"), new Date("2026-10-30T00:00:00").toDateString()); // Friday, window closed
  assert.equal(day("2026-10-24T09:00:00"), new Date("2026-10-30T00:00:00").toDateString()); // Saturday
});

test("posts go in one thread per shop, started on first use", async (t) => {
  const posts = await fakeGateway(t);
  const ctx = { store: new Store(":memory:"), household } as unknown as Context;
  await postToWeek(ctx, "first");
  await postToWeek(ctx, "second", { broadcast: true });
  assert.equal(posts.length, 3);
  assert.match(String(posts[0].text), /^\*\*Weekly shop: pickup Friday/);
  assert.equal(posts[0].threadTs, undefined);
  assert.deepEqual([posts[1].threadTs, posts[2].threadTs], ["9.1", "9.1"]);
  assert.equal(posts[2].broadcast, true);
});

test("logged changes are posted once, as one message, and the bot's own restocking is not news", async (t) => {
  const posts = await fakeGateway(t);
  const store = new Store(":memory:");
  const ctx = { store, household } as unknown as Context;
  const milk = store.addListItem({ text: "milk", quantity: "2", addedBy: "Carin" });
  store.setPantryItem({ name: "rice", status: "low", updatedBy: "Stephen" });
  store.setPantryItem({ name: "rice", status: "low", updatedBy: "Stephen" });
  store.setPantryItem({ name: "coffee", status: "have", updatedBy: "food-bot" });
  store.updateListItem(milk.id, { status: "ordered" });
  store.updateListItem(milk.id, { status: "removed" }, "Stephen");
  await postChanges(ctx);
  await postChanges(ctx);
  const changes = posts.filter((p) => String(p.text).startsWith("**Changes**"));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].text, "**Changes**\n- Carin added 2 x milk to the list\n- Stephen marked rice as low in the pantry\n- Stephen removed 2 x milk from the list");
});
