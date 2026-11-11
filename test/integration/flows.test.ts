import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { localDate, nextPickup } from "../../src/plan/week.ts";
import type { Household } from "../../src/core/household.ts";
import { NOW } from "./clock.ts";
import { goodDraft, SEARCHES, setup, type Env } from "./harness.ts";

// The weekly cycle end to end: the real CLI, database and MCP server against
// fake Willys, Resend and Slack, with Claude replaced by scripted turns.
// The processes they start run at NOW (clock.ts), so the week is the same
// whatever day the tests run on.

const WEEK = localDate(nextPickup({ config: { pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" } } } as unknown as Household, NOW));
const stephen = { email: "stephen@test.example", name: "Stephen" };
const where = (threadTs: string | null = null) => ({ channel: "C0FOOD", ts: `${Date.now() / 1000}`, threadTs });
const row = <T>(env: Env, sql: string, ...args: (string | number)[]) => env.db().prepare(sql).get(...args) as T;
const rows = <T>(env: Env, sql: string, ...args: (string | number)[]) => env.db().prepare(sql).all(...args) as T[];

async function plannedWeek(env: Env): Promise<void> {
  const milk = await env.wb(["list", "add", "milk", "--qty", "2"]);
  assert.equal(milk.code, 0, milk.stderr);
  env.claude([{ calls: SEARCHES, output: goodDraft([1]) }]);
  const res = await env.wb(["plan"]);
  assert.equal(res.code, 0, res.stderr);
}

async function slack(env: Env, req: object): Promise<{ reply?: string }> {
  const res = await env.wb(["slack"], JSON.stringify(req));
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split("\n").at(-1)!);
}

describe("the weekly cycle", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
    env.willys.setSlots(WEEK, [["16:30", "18:00"], ["18:00", "21:00"]]);
  });
  afterEach(() => env.stop());

  test("the scheduled plan drafts the week, emails it and posts it with buttons, once", async () => {
    await plannedWeek(env);
    const week = row<{ status: string; token: string }>(env, `SELECT status, token FROM weeks WHERE id = ?`, WEEK);
    assert.equal(week.status, "open");
    assert.equal(rows(env, `SELECT * FROM dishes WHERE week_id = ?`, WEEK).length, 2);
    assert.equal(row<{ source: string }>(env, `SELECT source FROM week_items WHERE product_code = 'MILK_ST'`).source, "request");
    assert.equal(env.resend.sent.length, 1);
    assert.match(env.resend.sent[0].subject, new RegExp(`\\[wb:${week.token}\\]`));
    const plan = env.gateway.posts.find((p) => p.buttons.length);
    assert.deepEqual(plan?.buttons.map((b) => [b.action, b.value]), [["plan.approve", WEEK], ["plan.skip", WEEK]]);
    assert.equal(plan?.broadcast, true);

    const again = await env.wb(["plan"]);
    assert.match(again.stdout, /already open: not drafting it again/);
    assert.equal(env.resend.sent.length, 1);
    assert.equal(env.claudeLog().length, 1);
  });

  test("a placeholder draft is retried twice and then nothing is saved or sent", async () => {
    const placeholder = { summary: "draft", dishes: [], lines: [{ productCode: "960257_PLACEHOLDER", qty: 1, reason: "", dish: 0, listItemIds: [], restocks: "" }], skipped: [], notes: "draft" };
    env.claude([{ output: placeholder }, { output: placeholder }, { output: placeholder }]);
    const res = await env.wb(["plan"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /failed its checks three times/);
    assert.match(env.claudeLog()[1].prompt, /Your previous answer was rejected/);
    assert.equal(row(env, `SELECT * FROM weeks WHERE id = ?`, WEEK), undefined);
    assert.equal(env.resend.sent.length, 0);
    assert.equal(env.gateway.posts.length, 0);
  });

  test("recipes that only cook in a poor order are sent back, and taken on the last try rather than losing the week", async () => {
    const draft = goodDraft();
    const recipe = draft.dishes[0]!.recipe;
    // The rice put on first, so it is ready long before the stew.
    draft.dishes[0]!.recipe = { ...recipe, steps: [recipe.steps.find((s) => s.id === "rice")!, ...recipe.steps.filter((s) => s.id !== "rice")] };
    env.claude([{ calls: SEARCHES, output: draft }, { output: draft }, { output: draft }]);
    const res = await env.wb(["plan"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(env.claudeLog()[1].prompt, /Dish 1 \(Chicken curry\): Step rice is ready \d+ minutes before step serve needs it/);
    // The retry gets its previous answer back, to fix rather than start over.
    assert.match(env.claudeLog()[1].prompt, /keep every other dish, line and recipe exactly as it was\. Your previous answer:\n```json\n\{"summary":/);
    assert.equal(env.claudeLog().length, 3);
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK)?.status, "open");
  });

  test("Approve fills the cart, books the evening slot and confirms it in the channel", async () => {
    await plannedWeek(env);
    await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    assert.deepEqual(Object.fromEntries(env.willys.cart), { CHICKEN_ST: 2, BEEF_ST: 2, BEANS_ST: 2, RICE_ST: 1, MILK_ST: 2 });
    assert.equal(env.willys.slotInCart, `TEST_Collect_${WEEK}_18:00`);
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK).status, "applied");
    assert.equal(row<{ status: string }>(env, `SELECT status FROM list_items WHERE id = 1`).status, "ordered");
    const confirm = env.gateway.posts.find((p) => p.text.startsWith("**Pickup booked**"));
    assert.ok(confirm, "a pickup confirmation is posted");
    assert.equal(confirm.broadcast, true);
    assert.match(confirm.text, /18:00-21:00/);
    assert.ok(env.gateway.posts.some((p) => p.text.startsWith("## Recipes") && p.threadTs));
    assert.ok(env.resend.sent.some((e) => /Pickup booked/.test(e.text) && /## Recipes/.test(e.text)));
  });

  test("when no slot can be booked, the filled cart still counts and the channel is told to pick one", async () => {
    await plannedWeek(env);
    env.willys.failing.add("/axfood/rest/v2/slot");
    await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    assert.equal(env.willys.cart.size, 5);
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK).status, "applied");
    const notice = env.gateway.posts.find((p) => p.text.startsWith("**Order ready, no pickup slot booked**"));
    assert.equal(notice?.broadcast, true);
    assert.match(notice?.text ?? "", /Booking the pickup slot failed/);
  });

  test("when the cart cannot be filled, the week fails, the list items go back and the channel is told", async () => {
    await plannedWeek(env);
    env.willys.failing.add("/axfood/rest/cart/addProducts");
    const res = await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    assert.deepEqual(res, {});
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK).status, "failed");
    assert.equal(row<{ status: string }>(env, `SELECT status FROM list_items WHERE id = 1`).status, "open");
    const notice = env.gateway.posts.find((p) => /Filling the cart failed/.test(p.text));
    assert.equal(notice?.broadcast, true);
  });

  test("a plain yes by email approves the week it answers", async () => {
    await plannedWeek(env);
    const { token } = row<{ token: string }>(env, `SELECT token FROM weeks WHERE id = ?`, WEEK);
    await env.wb(["inbox"]);
    env.resend.receive({ id: "m1", from: "Carin <carin@test.example>", subject: `Re: Willys order [wb:${token}]`, text: "Yes!\n\nOn Wed, food-bot wrote:\n> the plan" });
    const res = await env.wb(["inbox"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(row<{ decided_by: string }>(env, `SELECT decided_by FROM weeks WHERE id = ?`, WEEK).decided_by, "carin@test.example");
    assert.equal(env.willys.cart.size, 5);
    assert.equal(env.claudeLog().length, 1, "no Claude run for a plain yes");
  });

  test("email from a stranger or an unverified sender changes nothing and gets no answer", async () => {
    await plannedWeek(env);
    await env.wb(["inbox"]);
    const sent = env.resend.sent.length;
    env.resend.receive({ id: "x1", from: "mallory@evil.test", subject: "yes", text: "yes" });
    env.resend.receive({ id: "x2", from: "carin@test.example", subject: "yes", text: "yes", authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } });
    await env.wb(["inbox"]);
    assert.deepEqual(rows<{ status: string }>(env, `SELECT status FROM mail ORDER BY id`).map((m) => m.status), ["ignored", "ignored"]);
    assert.equal(env.resend.sent.length, sent);
    assert.equal(env.willys.cart.size, 0);
  });

  test("after approval, a change reaches the Willys cart while the order is not placed", async () => {
    await plannedWeek(env);
    await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    const beans = row<{ id: number }>(env, `SELECT id FROM week_items WHERE product_code = 'BEANS_ST'`);
    env.claude([{ calls: [{ tool: "week_remove_item", args: { itemId: beans.id } }], output: { reply: "Removed the beans.", redraft: "", summary: "removed beans" } }]);
    const res = await slack(env, { type: "message", from: stephen, text: "remove the beans", where: where(), thread: [] });
    assert.equal(env.willys.cart.has("BEANS_ST"), false);
    assert.equal(env.willys.cart.get("CHICKEN_ST"), 2);
    assert.match(res.reply ?? "", /^Removed the beans\.\n\nWillys cart: 4 products, total /);
    const run = env.claudeLog().at(-1)!;
    assert.match(run.prompt, /the order is not placed yet/);
    assert.equal(run.results[0].error, false);
  });

  test("after the order is placed, a change is recorded but the order is never touched", async () => {
    await plannedWeek(env);
    await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    env.willys.placeOrder();
    const before = env.willys.calls.filter((c) => c.path === "/axfood/rest/cart/addProducts").length;
    const beans = row<{ id: number }>(env, `SELECT id FROM week_items WHERE product_code = 'BEANS_ST'`);
    env.claude([{ calls: [{ tool: "week_remove_item", args: { itemId: beans.id } }], output: { reply: "Noted.", redraft: "", summary: "removed beans" } }]);
    const res = await slack(env, { type: "message", from: stephen, text: "remove the beans", where: where(), thread: [] });
    assert.equal(env.willys.calls.filter((c) => c.path === "/axfood/rest/cart/addProducts").length, before);
    assert.equal(res.reply, "Noted.");
    assert.match(env.claudeLog().at(-1)!.prompt, /already placed on willys\.se/);
  });

  test("Claude is told to answer in the language the member wrote in", async () => {
    await plannedWeek(env);
    env.claude([{ output: { reply: "ok", redraft: "", summary: "x" } }, { output: { reply: "ok", redraft: "", summary: "x" } }]);
    await slack(env, { type: "message", from: stephen, text: "also we want a week of skyr for Kycklinglårfilé fans", where: where(), thread: [{ from: "Carin", text: "Vi behöver mer mjölk och ägg" }] });
    await slack(env, { type: "message", from: stephen, text: "vi behöver också skyr till fredag", where: where(), thread: [] });
    const [en, sv] = env.claudeLog().slice(-2);
    assert.match(en.prompt, /Write your reply in English/);
    assert.match(sv.prompt, /Write your reply in Swedish/);
  });

  test("a week nobody decided is closed after its pickup day, and its list items go back on the list", async () => {
    await plannedWeek(env);
    const past = localDate(new Date(NOW.getTime() - 3 * 86_400_000));
    // Move the week into the past; foreign keys are checked at commit.
    const db = env.db();
    db.exec("BEGIN; PRAGMA defer_foreign_keys = ON");
    db.prepare(`UPDATE weeks SET id = ? WHERE id = ?`).run(past, WEEK);
    db.prepare(`UPDATE week_items SET week_id = ? WHERE week_id = ?`).run(past, WEEK);
    db.prepare(`UPDATE dishes SET week_id = ? WHERE week_id = ?`).run(past, WEEK);
    db.prepare(`UPDATE list_items SET plan_id = ? WHERE plan_id = ?`).run(past, WEEK);
    db.exec("COMMIT");
    await env.wb(["inbox"]);
    assert.equal(row<{ status: string; decided_by: string }>(env, `SELECT status, decided_by FROM weeks WHERE id = ?`, past).status, "skipped");
    assert.equal(row<{ status: string }>(env, `SELECT status FROM list_items WHERE id = 1`).status, "open");
  });

  test("a failed request in Slack answers with the error instead of going quiet", async () => {
    await plannedWeek(env);
    env.claude([{ error: "the model is overloaded", output: null }]);
    const res = await slack(env, { type: "message", from: stephen, text: "add skyr", where: where(), thread: [] });
    assert.match(res.reply ?? "", /^Sorry, that went wrong: .*the model is overloaded/);
    assert.ok(row<{ error: string }>(env, `SELECT error FROM slack_messages ORDER BY id DESC LIMIT 1`).error);
  });
});

describe("failure alerts", () => {
  let env: Env;
  before(async () => (env = await setup()));
  after(() => env.stop());

  test("a failed run emails the operator and posts in the channel, at most once every six hours", async () => {
    const first = await env.wb(["alert", "willys-bot-inbox@test.service"]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(env.resend.sent.map((e) => e.to), [["carin@test.example"]]);
    assert.ok(env.gateway.posts.some((p) => p.broadcast && /willys-bot-inbox@test\.service failed/.test(p.text)));
    await env.wb(["alert", "willys-bot-inbox@test.service"]);
    assert.equal(env.resend.sent.length, 1);
  });

  test("when systemd does not name the failed unit, the alert looks up the household's failed units", async () => {
    env.resend.sent.length = 0;
    env.failedUnits(["willys-bot-plan@test.service", "willys-bot-snapshot@test.service", "willys-bot-alert@test.service", "willys-bot-plan@other.service"]);
    const res = await env.wb(["alert"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(env.resend.sent.map((e) => e.subject), ["food-bot: willys-bot-plan@test.service failed", "food-bot: willys-bot-snapshot@test.service failed"]);
  });

  test("when no failed unit can be found, the operator still hears that a run failed", async () => {
    env.resend.sent.length = 0;
    env.failedUnits([]);
    const res = await env.wb(["alert"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(env.resend.sent.map((e) => e.subject), ["food-bot: a food-bot run failed"]);
  });
});

describe("standing orders", () => {
  let env: Env;
  before(async () => (env = await setup({ rules: { staples: [{ name: "skyr for Carin", productCode: "SKYR_ST", qty: 4 }] } })));
  after(() => env.stop());

  test("a standing order is in every drafted week as a request, and the planner is told it is there", async () => {
    // The product must be known before the week is drafted, as after any
    // earlier search or offer snapshot.
    env.claude([{ calls: [{ tool: "search_products", args: { query: "skyr" } }], output: { reply: "", redraft: "", summary: "" } }, { calls: SEARCHES, output: goodDraft() }]);
    await env.wb(["slack"], JSON.stringify({ type: "message", from: stephen, text: "what is on the list?", where: where(), thread: [] }));
    const res = await env.wb(["plan"]);
    assert.equal(res.code, 0, res.stderr);
    const skyr = row<{ qty: number; source: string; requested_by: string }>(env, `SELECT qty, source, requested_by FROM week_items WHERE product_code = 'SKYR_ST'`);
    assert.deepEqual([skyr.qty, skyr.source, skyr.requested_by], [4, "request", "standing order"]);
    assert.match(env.claudeLog().at(-1)!.prompt, /Already in this week's shop \(fixed\)[\s\S]*4 x Naturell Skyr 400g/);
  });
});

describe("a household that cooks three of six suggestions, as the Laus do", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup({ meals: 3, plan: { suggestions: 6 } });
  });
  afterEach(() => env.stop());

  // Six dishes, each with its own product, from the two in goodDraft.
  const sixDishes = () => {
    const d = goodDraft();
    const names = ["Chicken curry", "Chili con carne", "Lentil soup", "Fish pie", "Tofu stir fry", "Bean stew"];
    return {
      ...d,
      dishes: names.map((name, i) => ({ ...d.dishes[i % 2]!, name })),
      lines: [...names.map((_, i) => ({ productCode: i % 2 ? "BEEF_ST" : "CHICKEN_ST", qty: 1, reason: "Dish", dish: i + 1, listItemIds: [], restocks: "" })), d.lines.at(-1)!],
    };
  };

  test("the plan reaches Slack with a Pick button for each of the six dishes", async () => {
    env.claude([{ calls: SEARCHES, output: sixDishes() }]);
    const res = await env.wb(["plan"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(env.gateway.refused, []);
    const plan = env.gateway.posts.find((p) => p.buttons.length)!;
    assert.equal(plan.buttons.filter((b) => b.action === "plan.pick").length, 6);
    assert.equal(plan.broadcast, true);
  });

  test("a plan Slack refuses fails the run, so the alert goes out, and the next run posts it", async () => {
    env.claude([{ calls: SEARCHES, output: sixDishes() }]);
    env.gateway.failing = true;
    const failed = await env.wb(["plan"]);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /was emailed but its plan was not posted to Slack/);
    assert.equal(env.resend.sent.length, 1, "the email still went");

    env.gateway.failing = false;
    const again = await env.wb(["plan"]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /was emailed but not in Slack: posted it now/);
    assert.equal(env.gateway.posts.filter((p) => p.buttons.some((b) => b.action === "plan.pick")).length, 1);
    assert.equal(env.resend.sent.length, 1, "and is not emailed twice");
  });
});

describe("picking from more suggestions than the household cooks, and rating what they cooked", () => {
  let env: Env;
  beforeEach(async () => {
    // Two suggestions a week, one of them cooked.
    env = await setup({ meals: 1, plan: { suggestions: 2 } });
    env.willys.setSlots(WEEK, [["18:00", "21:00"]]);
  });
  afterEach(() => env.stop());

  const dishId = (name: string) => row<{ id: number }>(env, `SELECT id FROM dishes WHERE week_id = ? AND name = ?`, WEEK, name).id;

  test("the plan has a Pick button per dish; ordering waits for a pick and buys only the picked dish", async () => {
    await plannedWeek(env);
    const plan = env.gateway.posts.find((p) => p.buttons.length)!;
    assert.deepEqual(plan.buttons.map((b) => b.action), ["plan.pick", "plan.pick", "plan.approve", "plan.redraft", "plan.skip"]);
    assert.match(plan.text, /## Suggestions\n1\. \*\*Chicken curry\*\* \(6 portions, about \d+ kr, 37 min, 17 hands-on\)/);
    assert.match(env.resend.sent[0].text, /1, 3, 5/);

    const refused = await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    assert.match(refused.reply ?? "", /Pick the dishes you want to cook first/);
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK).status, "open");
    assert.equal(env.willys.cart.size, 0);

    await slack(env, { type: "action", from: stephen, action: { id: "plan.pick", value: `${WEEK}:${dishId("Chili con carne")}` }, where: where() });
    assert.equal(row<{ picked_by: string }>(env, `SELECT picked_by FROM dishes WHERE name = 'Chili con carne'`).picked_by, "stephen@test.example");
    const updated = env.gateway.posts.filter((p) => p.path === "/update").at(-1)!;
    assert.deepEqual(updated.buttons.map((b) => (b as { label?: string }).label), ["Pick 1. Chicken curry", "✓ 2. Chili con carne", "Order picked (1)", "New suggestions", "Skip this week"]);

    await slack(env, { type: "action", from: stephen, action: { id: "plan.approve", value: WEEK }, where: where() });
    assert.deepEqual(Object.fromEntries(env.willys.cart), { BEEF_ST: 2, BEANS_ST: 2, RICE_ST: 1, MILK_ST: 2 }, "the curry's chicken is not bought; basics and requests are");
    assert.ok(row<{ removed_at: string }>(env, `SELECT removed_at FROM dishes WHERE name = 'Chicken curry'`).removed_at);
    assert.equal(row<{ status: string }>(env, `SELECT status FROM weeks WHERE id = ?`, WEEK).status, "applied");
  });

  test("a reply of numbers picks dishes, and with yes orders them, without asking Claude", async () => {
    await plannedWeek(env);
    const { token } = row<{ token: string }>(env, `SELECT token FROM weeks WHERE id = ?`, WEEK);
    await env.wb(["inbox"]);
    env.resend.receive({ id: "p1", from: "Carin <carin@test.example>", subject: `Re: Willys order [wb:${token}]`, text: "1\n\nOn Wed, food-bot wrote:\n> the plan" });
    await env.wb(["inbox"]);
    assert.equal(row<{ picked_by: string }>(env, `SELECT picked_by FROM dishes WHERE name = 'Chicken curry'`).picked_by, "carin@test.example");
    assert.match(env.resend.sent.at(-1)!.text, /Carin picked 1\. Chicken curry\. Reply \*\*yes\*\* to order them/);
    assert.equal(env.willys.cart.size, 0, "picking alone does not order");

    env.resend.receive({ id: "p2", from: "Carin <carin@test.example>", subject: `Re: Willys order [wb:${token}]`, text: "2 yes" });
    await env.wb(["inbox"]);
    assert.deepEqual(Object.fromEntries(env.willys.cart), { BEEF_ST: 2, BEANS_ST: 2, RICE_ST: 1, MILK_ST: 2 }, "2 yes picks exactly dish 2 and orders it");
    assert.equal(env.claudeLog().length, 1, "only the planner ran");
  });

  test("numbers in the plan's Slack thread pick those dishes", async () => {
    await plannedWeek(env);
    const plan = env.gateway.posts.find((p) => p.buttons.length)!;
    const res = await slack(env, { type: "message", from: stephen, text: "1 and 2", where: where(plan.ts!), thread: [] });
    assert.match(res.reply ?? "", /Stephen picked 1\. Chicken curry, 2\. Chili con carne\. Tap Order picked/);
    assert.equal(rows(env, `SELECT id FROM dishes WHERE week_id = ? AND picked_by IS NOT NULL`, WEEK).length, 2);
  });

  test("the survey asks about the last week's dishes once, and the star buttons record ratings", async () => {
    assert.equal((await env.wb(["weeks"])).code, 0, "creates the database");
    const db = env.db();
    db.exec(`INSERT INTO weeks (id, token, status, created_at) VALUES ('2020-01-03', 'past0001', 'applied', '2020-01-01')`);
    db.exec(`INSERT INTO dishes (week_id, name, portions, why, origin, added_by, added_at) VALUES ('2020-01-03', 'Chili', 6, '', NULL, 'planner', '2020-01-01'), ('2020-01-03', 'Khachapuri', 6, '', 'Georgia', 'planner', '2020-01-01')`);
    db.close();

    const res = await env.wb(["survey", "--force"]);
    assert.match(res.stdout, /Asked how the food from 2020-01-03 was \(2 dishes\)/);
    const mail = env.resend.sent.at(-1)!;
    assert.match(mail.subject, /How was the food from .* \[wb:past0001\]/);
    assert.match(mail.text, /1\. \*\*Chili\*\*\n2\. \*\*Khachapuri\*\* \(wildcard from Georgia\)/);
    const posts = env.gateway.posts.filter((p) => p.buttons.some((b) => b.action === "dish.rate"));
    assert.deepEqual(posts.map((p) => p.text), ["**Chili**: not rated yet", "**Khachapuri** 🌍 Georgia: not rated yet"]);

    const chili = row<{ id: number }>(env, `SELECT id FROM dishes WHERE name = 'Chili'`).id;
    await slack(env, { type: "action", from: stephen, action: { id: "dish.rate", value: `${chili}:4` }, where: { channel: "C0FOOD", ts: posts[0]!.ts!, threadTs: null } });
    assert.deepEqual({ ...row<object>(env, `SELECT member, stars FROM ratings WHERE dish_id = ?`, chili) }, { member: "Stephen", stars: 4 });
    const shown = env.gateway.posts.filter((p) => p.path === "/update").at(-1)!;
    assert.equal(shown.ts, posts[0]!.ts);
    assert.equal(shown.text, "**Chili**: ★★★★☆ Stephen");

    const again = await env.wb(["survey", "--force"]);
    assert.match(again.stdout, /No survey to send/);
  });
});
