import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { handleSlack } from "./slack.ts";

const household = {
  id: "test",
  dir: "/nonexistent",
  preferences: "",
  config: {
    name: "Test",
    members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }],
    mail: { address: "food@ai.lau.engineering", name: "food-bot", secret: "test" },
    slack: { bot: "food" },
  },
} as unknown as Household;

const carin = { email: "carin@lau.engineering", name: "Carin" };
const where = (threadTs: string | null = null) => ({ channel: "C0FOOD", ts: "3.3", threadTs });

// A stand-in for slack-gateway's outbox socket that records what food-bot sends.
async function fakeGateway(t: { after: (f: () => void) => void }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const path = join(mkdtempSync(join(tmpdir(), "gw-")), "s.sock");
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ path: req.url ?? "", body: JSON.parse(raw) });
    res.end(JSON.stringify({ channel: "C0FOOD", ts: "8.8" }));
  });
  await new Promise<void>((r) => server.listen(path, r));
  process.env.SLACK_GATEWAY_SOCKET = path;
  t.after(() => {
    server.close();
    delete process.env.SLACK_GATEWAY_SOCKET;
  });
  return calls;
}

function openWeek(store: Store) {
  store.claimWeek("2026-10-30");
  store.updateWeek("2026-10-30", { status: "open", summary: "s" });
  store.set("week.2026-10-30.slack", JSON.stringify({ channel: "C0FOOD", ts: "1.1" }));
  store.set("slack.thread.1.1", "2026-10-30");
  return store.week("2026-10-30")!;
}

test("people outside the household are turned away", async () => {
  const store = new Store(":memory:");
  const res = await handleSlack({ store, household } as unknown as Context, { type: "message", from: { email: "x@evil.test", name: "X" }, text: "add caviar", where: where(), thread: [] });
  assert.match(res.reply ?? "", /only take requests from the household/);
});

test("Skip on an open week skips it and replaces the post with the outcome", async (t) => {
  const calls = await fakeGateway(t);
  const store = new Store(":memory:");
  const week = openWeek(store);
  const res = await handleSlack({ store, household } as unknown as Context, { type: "action", from: carin, action: { id: "plan.skip", value: week.id }, where: where() });
  assert.deepEqual(res, {});
  assert.equal(store.week(week.id)?.status, "skipped");
  assert.equal(store.week(week.id)?.decidedBy, "carin@lau.engineering");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/update");
  assert.equal(calls[0].body.ts, "1.1");
  assert.match(String(calls[0].body.text), /Skipped this week by Carin/);
});

test("a plain no in the week's thread skips it too", async (t) => {
  await fakeGateway(t);
  const store = new Store(":memory:");
  const week = openWeek(store);
  await handleSlack({ store, household } as unknown as Context, { type: "message", from: carin, text: "nej", where: where("1.1"), thread: [] });
  assert.equal(store.week(week.id)?.status, "skipped");
});

test("a button on a week that was already decided says so and changes nothing", async (t) => {
  const calls = await fakeGateway(t);
  const store = new Store(":memory:");
  const week = openWeek(store);
  store.updateWeek(week.id, { status: "skipped", decidedBy: "carin@lau.engineering" });
  const res = await handleSlack({ store, household } as unknown as Context, { type: "action", from: carin, action: { id: "plan.approve", value: week.id }, where: where() });
  assert.equal(res.reply, "This week is already skipped (Carin).");
  assert.equal(store.week(week.id)?.status, "skipped");
  assert.equal(calls.length, 0);
});

test("a button on a plan from before weeks points to the latest plan", async () => {
  const store = new Store(":memory:");
  const res = await handleSlack({ store, household } as unknown as Context, { type: "action", from: carin, action: { id: "plan.approve", value: "2026-10-20-1d5faf" }, where: where() });
  assert.match(res.reply ?? "", /use the buttons on the latest plan/);
});

test("every message food-bot handles is recorded with its answer, strangers included", async () => {
  const store = new Store(":memory:");
  await handleSlack({ store, household } as unknown as Context, { type: "message", from: { email: "x@evil.test", name: "X" }, text: "add caviar", where: where("2.2"), thread: [] });
  const [m] = store.slackMessages();
  assert.deepEqual([m.sender, m.kind, m.text, m.threadTs], ["x@evil.test", "message", "add caviar", "2.2"]);
  assert.match(m.reply ?? "", /only take requests from the household/);
});
