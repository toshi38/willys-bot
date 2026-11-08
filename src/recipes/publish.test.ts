import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import { Store, type Week } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { gitPush, publishWeeks, unpublishedWeeks } from "./publish.ts";
import { sampleRecipe } from "./sample.ts";

const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));

function weekWith(store: Store, id: string, status: "open" | "applied") {
  store.claimWeek(id);
  const r = store.saveRecipe({ name: "Stew", ingredients: "x", method: "y", structured: sampleRecipe(4) }, "planner");
  store.addDish(id, { name: "Stew", portions: 4, recipeId: r.id }, "planner");
  store.switchWeek(id, "drafting", status);
}

test("only ordered weeks whose order is placed go on the site, each once", async () => {
  const store = new Store(":memory:");
  weekWith(store, day(-30), "applied");
  weekWith(store, day(-3), "applied");
  weekWith(store, day(4), "applied");
  weekWith(store, day(11), "open");
  assert.deepEqual(unpublishedWeeks(store).map((w) => w.id), [day(4), day(-3)]);

  const pushed: { path: string; content: string; message: string }[] = [];
  let placed = new Set([day(-3)]);
  const publisher = {
    placed: async (w: Week) => placed.has(w.id),
    push: (path: string, content: string, message: string) => (pushed.push({ path, content, message }), true),
  };
  const ctx = { store } as unknown as Context;
  assert.deepEqual(await publishWeeks(ctx, publisher), [`${day(4)}: the order is not placed yet`, `${day(-3)}: published`]);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.path, `site-data/weeks/${day(-3)}.json`);
  const week = JSON.parse(pushed[0]!.content);
  assert.deepEqual([week.pickup, week.dishes[0].name, week.dishes[0].fromText], [day(-3), "Stew", false]);
  assert.match(pushed[0]!.message, /^Publish week \d+'s recipes$/);

  placed = new Set([day(-3), day(4)]);
  assert.deepEqual(await publishWeeks(ctx, publisher), [`${day(4)}: published`]);
  assert.deepEqual(await publishWeeks(ctx, publisher), []);
});

test("a week's file is committed to main and pushed, and a week main already has is left as it is", () => {
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
    assert.equal(gitPush(join(root, "site"), "site-data/weeks/2026-11-13.json", '{"a":2}\n', "Publish week 46's recipes"), false);
    assert.equal(git(origin, "rev-list", "--count", "main"), "2");
    assert.equal(git(origin, "show", "main:site-data/weeks/2026-11-13.json"), '{"a":1}');
    assert.equal(readFileSync(join(root, "site", "site-data/weeks/2026-11-13.json"), "utf8"), '{"a":1}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
