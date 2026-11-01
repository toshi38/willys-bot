import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Recipe } from "./recipe.ts";
import { cookData, type CookData } from "./site.ts";

// The cook mode script the site ships, run without a page: it only defines
// Cook, and the tests drive its functions.
const source = readFileSync(new URL("../../site/cook.js", import.meta.url), "utf8");
const sandbox: { Cook?: any } = {};
runInNewContext(source, sandbox);
const Cook = sandbox.Cook;

const skill = readFileSync(new URL("../../.claude/skills/recipe-writing/SKILL.md", import.meta.url), "utf8");
const example = Recipe.parse(JSON.parse(skill.match(/```json\n([\s\S]*?)```/)![1]!));
const data: CookData = cookData({ title: "Food", language: "en" }, { pickup: "2026-10-30", dishes: [{ name: example.name, portions: 6, recipe: example, fromText: false }] }, 0);
const step = (id: string) => data.steps.find((s) => s.id === id)!;
const pos = (id: string) => data.steps.findIndex((s) => s.id === id) + 1;
const MIN = 60000;
// Objects made in the sandbox have its prototypes, so compare them as JSON.
const eq = (actual: unknown, expected: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test("the script defines Cook and does not start without a page", () => {
  assert.equal(typeof Cook.bodyHtml, "function");
});

test("clocks show minutes and seconds, hours when needed, and never go negative", () => {
  assert.equal(Cook.clock(0), "0:00");
  assert.equal(Cook.clock(4 * MIN + 5000), "4:05");
  assert.equal(Cook.clock(12 * MIN), "12:00");
  assert.equal(Cook.clock(62 * MIN + 3000), "1:02:03");
  assert.equal(Cook.clock(-5000), "0:00");
  assert.equal(Cook.clock(500), "0:01", "a part second still shows as a second left");
});

test("a saved state comes back unless it is broken or out of range", () => {
  eq(Cook.restore(null, 6), { pos: 0, timers: [] });
  eq(Cook.restore({ pos: "3" }, 6), { pos: 0, timers: [] });
  eq(Cook.restore({ pos: 9, timers: [] }, 6), { pos: 0, timers: [] });
  const t = { id: "curry", label: "Curry", end: 5, total: 5, ringing: false };
  eq(Cook.restore({ pos: 4, timers: [t, { id: 3 }, null] }, 6), { pos: 4, timers: [t] });
});

test("timers start once, count down, take an extra minute, ring when done and stop", () => {
  const state = Cook.newState();
  assert.equal(Cook.start(state, step("curry"), 0), true);
  assert.equal(Cook.start(state, step("curry"), 1000), false, "a running timer does not restart");
  assert.equal(Cook.start(state, step("chop"), 0), false, "a step without a timer starts nothing");
  const t = Cook.timerFor(state, "curry");
  eq(Cook.timerView(t, 5 * MIN), { text: "15:00", left: 0.75 });
  Cook.addMinute(state, "curry");
  assert.equal(Cook.timerView(t, 5 * MIN).text, "16:00");
  assert.equal(Cook.tick(state, 20 * MIN), false);
  assert.equal(Cook.tick(state, 21 * MIN), true, "it rings at its end");
  assert.equal(Cook.tick(state, 22 * MIN), false, "and reports it once");
  assert.equal(Cook.ringing(state), true);
  assert.equal(Cook.timerView(t, 22 * MIN).text, null);
  Cook.addMinute(state, "curry");
  assert.equal(t.end, 21 * MIN, "a ringing timer takes no more minutes");
  Cook.stop(state, "curry");
  eq(state.timers, []);
  assert.equal(Cook.ringing(state), false);
});

test("moving goes from the overview through every step and leaves after the last", () => {
  const state = Cook.newState();
  assert.equal(Cook.move(state, -1, 6), 0, "not before the overview");
  for (let n = 1; n <= 6; n++) assert.equal(Cook.move(state, 1, 6), n);
  assert.equal(Cook.move(state, 1, 6), "leave");
  assert.equal(state.pos, 0, "and starts over next time");
});

test("the overview lists the equipment and every ingredient", () => {
  const html = Cook.bodyHtml(data, Cook.newState(), 0);
  assert.match(html, /Before you start/);
  assert.match(html, /<h4>You need<\/h4><p>large pot, saucepan with lid<\/p>/);
  assert.equal(html.match(/<li>/g)!.length, example.ingredients.length);
  assert.equal(Cook.goHtml(data, Cook.newState()), "");
  assert.equal(Cook.navLabel(data, Cook.newState()), "Start cooking");
  assert.equal(Cook.countLabel(data, Cook.newState()), "Before you start");
});

test("a step shows its kind, heat, ingredients, the next step and its timer button", () => {
  const state = { pos: pos("rice"), timers: [] };
  const html = Cook.bodyHtml(data, state, 0);
  assert.match(html, /<span class="pill">Simmer · Low heat<\/span>/);
  assert.match(html, /<li><span><b>6 dl<\/b> jasmine rice/);
  assert.match(html, /This runs on its own/);
  assert.match(html, /<p class="next-up"><b>Next<\/b>Squeeze the lime/);
  assert.match(html, /^<div class="main">.*<\/div><div class="side">.*<\/div>$/s, "the text and the ingredients are separate columns");
  assert.equal(Cook.goHtml(data, state), '<button class="go" data-act="go">Start rice timer <small>12 to 15 min</small></button>');
  assert.equal(Cook.countLabel(data, state), "Step 5 of 6");
  assert.equal(Cook.kindOf(data, state), "simmer");
  Cook.start(state, step("rice"), 0);
  assert.match(Cook.goHtml(data, state), /disabled>Timer running</);
});

test("a step waiting on running timers says so, and stops once they ring", () => {
  const state = { pos: pos("finish"), timers: [] as unknown[] };
  Cook.start(state, step("curry"), 0);
  Cook.start(state, step("rice"), 0);
  assert.match(Cook.bodyHtml(data, state, 5 * MIN), /Waits for: Curry <b data-left="curry">15:00<\/b>, Rice <b data-left="rice">7:00<\/b>/);
  Cook.tick(state, 13 * MIN);
  assert.match(Cook.bodyHtml(data, state, 13 * MIN), /Waits for: Curry <b data-left="curry">7:00<\/b><\/div>/);
  assert.equal(Cook.navLabel(data, state), "Done");
});

test("the timer strip shows running and ringing timers and the next one to start", () => {
  const state = { pos: pos("curry"), timers: [] as unknown[] };
  assert.match(Cook.timersHtml(data, state, 0), /<div class="tm ghost"><div><span>Next timer<\/span><b[^>]*>Curry<\/b>/);
  Cook.start(state, step("curry"), 0);
  let html = Cook.timersHtml(data, state, 0);
  assert.match(html, /<div class="tm k-simmer"><svg/);
  assert.match(html, /<b data-left="curry">20:00<\/b><span>Curry<\/span>/);
  assert.match(html, /data-act="add" data-id="curry"/);
  assert.match(html, /Next timer<\/span><b[^>]*>Rice</, "the next one is the rice");
  Cook.tick(state, 21 * MIN);
  html = Cook.timersHtml(data, state, 21 * MIN);
  assert.match(html, /<div class="tm k-simmer ringing"><div><b data-left="curry">Done!<\/b>/);
  assert.doesNotMatch(html, /data-act="add"/);
});

test("progress marks done, current and later steps", () => {
  assert.equal(Cook.progressHtml(data, { pos: 2, timers: [] }), '<i class="done"></i><i class="now"></i>' + '<i class=""></i>'.repeat(4));
});

test("text from the recipe is escaped in cook mode", () => {
  const evil = structuredClone(data);
  evil.steps[0]!.text = "<img src=x onerror=alert(1)>";
  evil.steps[0]!.chips = ['"><script>'];
  const html = Cook.bodyHtml(evil, { pos: 1, timers: [] }, 0);
  assert.doesNotMatch(html, /<img|<script/);
  const timers = Cook.timersHtml(evil, { pos: 1, timers: [{ id: '"x', label: "<b>", end: MIN, total: MIN, ringing: false }] }, 0);
  assert.doesNotMatch(timers, /<b>|"x/);
});
