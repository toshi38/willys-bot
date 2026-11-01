import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store, type Week, type WeekStatus } from "../core/store.ts";
import { editable, localDate, nextPickup, postChanges, postToWeek, weekThread } from "./week.ts";

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

test("two processes posting at once start one thread and post each change once", async (t) => {
  const posts = await fakeGateway(t);
  const dir = mkdtempSync(join(tmpdir(), "db-"));
  const a = new Store(join(dir, "db.sqlite"));
  const b = new Store(join(dir, "db.sqlite"));
  const ctxA = { store: a, household } as unknown as Context;
  const ctxB = { store: b, household } as unknown as Context;
  const [ta, tb] = await Promise.all([weekThread(ctxA), weekThread(ctxB)]);
  assert.deepEqual(ta, tb);
  a.addListItem({ text: "rice", addedBy: "Carin" });
  await Promise.all([postChanges(ctxA), postChanges(ctxB)]);
  assert.equal(posts.filter((p) => String(p.text).startsWith("**Weekly shop")).length, 1);
  assert.equal(posts.filter((p) => String(p.text).startsWith("**Changes**")).length, 1);
});

const pickupOn = (weekdays: string[], latest = "20:00") => ({ ...household, config: { ...household.config, pickup: { weekdays, earliest: "17:00", latest } } }) as unknown as Household;

test("with several pickup days, the shop runs to whichever comes next", () => {
  const h = pickupOn(["mon", "thu"]);
  const day = (s: string) => localDate(nextPickup(h, new Date(s)));
  assert.equal(day("2026-11-01T12:00:00"), "2026-11-02"); // Sunday
  assert.equal(day("2026-11-02T19:59:00"), "2026-11-02"); // Monday, window open
  assert.equal(day("2026-11-02T20:00:00"), "2026-11-05"); // Monday, window closed
  assert.equal(day("2026-11-03T08:00:00"), "2026-11-05"); // Tuesday
  assert.equal(day("2026-11-05T21:30:00"), "2026-11-09"); // Thursday, window closed
  assert.equal(day("2026-12-31T21:00:00"), "2027-01-04"); // across the new year
});

test("the pickup day is a local midnight", () => {
  const d = nextPickup(pickupOn(["mon"]), new Date("2026-11-01T12:34:56"));
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds()], [0, 0, 0]);
});

test("a window that closes at midnight moves the shop to the same day next week", () => {
  assert.equal(localDate(nextPickup(pickupOn(["fri"], "00:00"), new Date("2026-10-23T00:00:00"))), "2026-10-30");
});

test("a household with no pickup days has no next pickup", () => {
  assert.throws(() => nextPickup(pickupOn([]), new Date("2026-10-23T10:00:00")), /no pickup day in the next week/);
});

const weekWith = (id: string, status: WeekStatus) => ({ id, status }) as Week;

test("an open week takes changes, and an approved one until its pickup day has passed", () => {
  const today = "2026-10-30";
  for (const id of ["2026-10-29", "2026-10-30", "2026-11-06"]) assert.equal(editable(weekWith(id, "open"), today), true, id);
  assert.equal(editable(weekWith("2026-11-06", "applied"), today), true);
  assert.equal(editable(weekWith("2026-10-30", "applied"), today), true);
  assert.equal(editable(weekWith("2026-10-29", "applied"), today), false);
  for (const status of ["drafting", "approved", "skipped", "failed"] as const) {
    assert.equal(editable(weekWith("2026-11-06", status), today), false, status);
  }
});

test("editable judges an approved week against today by default", () => {
  const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));
  assert.equal(editable(weekWith(day(1), "applied")), true);
  assert.equal(editable(weekWith(day(0), "applied")), true);
  assert.equal(editable(weekWith(day(-1), "applied")), false);
});

test("a local date is the calendar day where the bot runs, zero padded", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(localDate(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});
