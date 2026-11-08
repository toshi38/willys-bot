import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "../core/context.ts";
import { dataDir, type Store, type Week } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { orderState } from "../plan/weekly.ts";
import { siteWeek } from "./export.ts";
import { leakProblems } from "./leaks.ts";
import { isoWeek } from "./site.ts";

// Puts a week's recipes on the recipe site once its order is placed on
// willys.se, and not before: until then the household can still change the
// dishes. The week goes into site-data/weeks/<pickup>.json in a clone of
// this repository kept next to the household's data, and is pushed to main,
// which Netlify builds from.

const publishedKey = (weekId: string) => `site.published.${weekId}`;

// Ordered weeks not yet on the site, from the last two weeks on: older ones
// were cooked long ago.
export function unpublishedWeeks(store: Store, today = localDate(new Date())): Week[] {
  const from = localDate(new Date(new Date(`${today}T12:00:00`).getTime() - 14 * 86_400_000));
  return store.weeks().filter((w) => w.status === "applied" && w.id >= from && !store.get(publishedKey(w.id)));
}

export interface Publisher {
  // Whether the week's order is placed, so its dishes can no longer change.
  placed(week: Week): Promise<boolean>;
  // Writes the file into the site's data and pushes it; false when the
  // site already has the week, which is then left as it is.
  push(path: string, content: string, message: string): boolean;
}

export async function publishWeeks(ctx: Context, publisher: Publisher = gitPublisher(ctx)): Promise<string[]> {
  const { store } = ctx;
  const out: string[] = [];
  for (const week of unpublishedWeeks(store)) {
    if (!(await publisher.placed(week))) {
      out.push(`${week.id}: the order is not placed yet`);
      continue;
    }
    const path = `site-data/weeks/${week.id}.json`;
    const content = `${JSON.stringify(siteWeek(store, week.id), null, 2)}\n`;
    const leaks = leakProblems(path, content);
    if (leaks.length) throw new Error(`Not publishing ${week.id}: ${leaks.join(" ")}`);
    const pushed = publisher.push(path, content, `Publish week ${isoWeek(week.id)}'s recipes`);
    store.set(publishedKey(week.id), new Date().toISOString());
    out.push(`${week.id}: ${pushed ? "published" : "already on the site"}`);
  }
  return out;
}

function gitPublisher(ctx: Context): Publisher {
  return {
    placed: async (week) => (await orderState(ctx, week)).placed,
    push: (path, content, message) => gitPush(join(dataDir(ctx.household.id), "site-repo"), path, content, message),
  };
}

// Commits one file to main in the clone at `dir`, made from this checkout's
// origin the first time, and pushes it, trying again on top of whatever
// reached main meanwhile. A file main already has is left alone: a week on
// the site stays as it went up, hand edits included.
export function gitPush(dir: string, path: string, content: string, message: string): boolean {
  if (!existsSync(join(dir, ".git"))) {
    const root = new URL("../../", import.meta.url).pathname;
    const origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    execFileSync("git", ["clone", "-q", "--branch", "main", origin, dir], { stdio: ["ignore", "ignore", "pipe"] });
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 1; ; attempt++) {
    git("fetch", "-q", "origin", "main");
    git("reset", "-q", "--hard", "origin/main");
    if (existsSync(join(dir, path))) return false;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git("add", "--", path);
    git("commit", "-q", "-m", message);
    try {
      git("push", "-q", "origin", "HEAD:main");
      return true;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}
