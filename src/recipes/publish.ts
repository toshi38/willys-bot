import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "../core/context.ts";
import { dataDir, type Store } from "../core/store.ts";
import { localDate } from "../plan/week.ts";
import { siteWeek } from "./export.ts";
import { leakProblems } from "./leaks.ts";
import { isoWeek } from "./site.ts";

// Puts a week's recipes on the recipe site as soon as the week is ordered,
// that is approved with its cart filled, so the household can read them
// ahead of the pickup. Until checkout the household can still change the
// dishes, so a week whose content changes before its pickup goes up again. The week goes into
// weeks/<pickup>.json in the household's site repository (`site.repo` in
// household.json), cloned next to the household's data, and is pushed to
// main, which Netlify builds from.

const publishedKey = (weekId: string) => `site.publishedHash.${weekId}`;

export interface Pending {
  weekId: string;
  path: string;
  content: string;
  hash: string;
}

// Ordered weeks from the last two weeks on (older ones were cooked long
// ago) that are not on the site yet, or whose content differs from what
// last went up while their pickup is still ahead. A week once picked up
// stays on the site as it is, hand edits included.
export function pendingWeeks(store: Store, today = localDate(new Date())): Pending[] {
  const from = localDate(new Date(new Date(`${today}T12:00:00`).getTime() - 14 * 86_400_000));
  return store
    .weeks()
    .filter((w) => w.status === "applied" && w.id >= from)
    .map((w) => {
      const content = `${JSON.stringify(siteWeek(store, w.id), null, 2)}\n`;
      return { weekId: w.id, path: `weeks/${w.id}.json`, content, hash: createHash("sha256").update(content).digest("hex") };
    })
    .filter((p) => {
      const published = store.get(publishedKey(p.weekId));
      return published === null || (published !== p.hash && p.weekId >= today);
    });
}

// Writes the file into the site's data and pushes it; false when the site
// already has exactly that content.
export type Push = (path: string, content: string, message: string) => boolean;

export function publishWeeks(ctx: Context, push: Push | null = gitPublisher(ctx)): string[] {
  const { store } = ctx;
  if (!push) return [];
  const out: string[] = [];
  for (const p of pendingWeeks(store)) {
    const leaks = leakProblems(p.path, p.content);
    if (leaks.length) throw new Error(`Not publishing ${p.weekId}: ${leaks.join(" ")}`);
    const pushed = push(p.path, p.content, `Publish week ${isoWeek(p.weekId)}'s recipes`);
    store.set(publishedKey(p.weekId), p.hash);
    out.push(`${p.weekId}: ${pushed ? "published" : "already on the site"}`);
  }
  return out;
}

// Null when the household has no site repository.
function gitPublisher(ctx: Context): Push | null {
  const repo = ctx.household.config.site?.repo;
  if (!repo) return null;
  return (path, content, message) => gitPush(join(dataDir(ctx.household.id), "site-repo"), repo, path, content, message);
}

// Commits one file to main in the clone of `repo` at `dir`, cloning it the
// first time, and pushes it, trying again on top of whatever reached main
// meanwhile. Nothing is committed when main already has that content.
export function gitPush(dir: string, repo: string, path: string, content: string, message: string): boolean {
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["clone", "-q", "--branch", "main", repo, dir], { stdio: ["ignore", "ignore", "pipe"] });
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("remote", "set-url", "origin", repo);
  for (let attempt = 1; ; attempt++) {
    git("fetch", "-q", "origin", "main");
    git("reset", "-q", "--hard", "origin/main");
    if (existsSync(join(dir, path)) && readFileSync(join(dir, path), "utf8") === content) return false;
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
