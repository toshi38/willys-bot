import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import { Store } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { gitPush, pendingWeeks, publishWeeks } from "./publish.ts";
import { sampleRecipe } from "./sample.ts";

const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));

function weekWith(store: Store, id: string, status: "open" | "applied") {
  store.claimWeek(id);
  const r = store.saveRecipe({ name: "Stew", ingredients: "x", method: "y", structured: sampleRecipe(4) }, "planner");
  store.addDish(id, { name: "Stew", portions: 4, recipeId: r.id }, "planner");
  store.switchWeek(id, "drafting", status);
}

test("ordered weeks go on the site as soon as they are approved, and again only when they change", () => {
  const store = new Store(":memory:");
  weekWith(store, day(-30), "applied");
  weekWith(store, day(-3), "applied");
  weekWith(store, day(4), "applied");
  weekWith(store, day(11), "open");
  assert.deepEqual(pendingWeeks(store).map((p) => p.weekId), [day(4), day(-3)]);

  const pushed: { path: string; content: string; message: string }[] = [];
  const push = (path: string, content: string, message: string) => (pushed.push({ path, content, message }), true);
  const ctx = { store } as unknown as Context;
  assert.deepEqual(publishWeeks(ctx, push), [`${day(4)}: published`, `${day(-3)}: published`]);
  const last = pushed.find((p) => p.path === `site-data/weeks/${day(-3)}.json`)!;
  const week = JSON.parse(last.content);
  assert.deepEqual([week.pickup, week.dishes[0].name, week.dishes[0].fromText], [day(-3), "Stew", false]);
  assert.match(last.message, /^Publish week \d+'s recipes$/);
  assert.deepEqual(publishWeeks(ctx, push), []);

  const r = store.saveRecipe({ name: "Soup", ingredients: "x", method: "y", structured: sampleRecipe(2) }, "member");
  store.addDish(day(4), { name: "Soup", portions: 2, recipeId: r.id }, "member");
  assert.deepEqual(publishWeeks(ctx, push), [`${day(4)}: published`]);
  assert.deepEqual(JSON.parse(pushed.at(-1)!.content).dishes.map((d: { name: string }) => d.name).sort(), ["Soup", "Stew"]);
  assert.deepEqual(publishWeeks(ctx, push), []);

  // A week already picked up is not replaced, since the site's copy may be edited by hand.
  const s = store.saveRecipe({ name: "Salad", ingredients: "x", method: "y", structured: sampleRecipe(2) }, "member");
  store.addDish(day(-3), { name: "Salad", portions: 2, recipeId: s.id }, "member");
  assert.deepEqual(publishWeeks(ctx, push), []);
});

test("a week's file is committed to main and pushed, and content main already has is not committed again", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-"));
  try {
    const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", origin, seed]);
    git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "start");
    git(seed, "push", "-q", "origin", "HEAD:main");
    execFileSync("git", ["clone", "-q", "--branch", "main", origin, join(root, "site")]);
    git(join(root, "site"), "config", "user.name", "t");
    git(join(root, "site"), "config", "user.email", "t@example.com");

    assert.equal(gitPush(join(root, "site"), "site-data/weeks/2026-11-13.json", '{"a":1}\n', "Publish week 46's recipes"), true);
    assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Publish week 46's recipes");
    assert.equal(git(origin, "show", "main:site-data/weeks/2026-11-13.json"), '{"a":1}');
    assert.equal(gitPush(join(root, "site"), "site-data/weeks/2026-11-13.json", '{"a":1}\n', "Publish week 46's recipes"), false);
    assert.equal(git(origin, "rev-list", "--count", "main"), "2");
    assert.equal(gitPush(join(root, "site"), "site-data/weeks/2026-11-13.json", '{"a":2}\n', "Publish week 46's recipes"), true);
    assert.equal(git(origin, "rev-list", "--count", "main"), "3");
    assert.equal(git(origin, "show", "main:site-data/weeks/2026-11-13.json"), '{"a":2}');
    assert.equal(readFileSync(join(root, "site", "site-data/weeks/2026-11-13.json"), "utf8"), '{"a":2}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
