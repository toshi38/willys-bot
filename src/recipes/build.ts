import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { recipeProblems } from "./check.ts";
import { leakProblems } from "./leaks.ts";
import { buildSite, SiteConfig, SiteWeek } from "./site.ts";

// Builds the recipe site from exported recipe data:
//   <data>/site.json         { "title": "...", "language": "en" }
//   <data>/weeks/<date>.json one SiteWeek per pickup
// into <out>, replacing what is there. It stops on data that does not
// parse or that looks like it carries a secret, and prints recipe problems
// as warnings.

const { values } = parseArgs({ options: { data: { type: "string" }, out: { type: "string", default: "dist" } } });
if (!values.data) {
  console.error("usage: build.ts --data <dir> [--out dist]");
  process.exit(2);
}
const data = values.data;
const read = (path: string) => readFileSync(path, "utf8");
const problems: string[] = [];

let config: SiteConfig;
try {
  config = SiteConfig.parse(JSON.parse(read(join(data, "site.json"))));
} catch {
  config = SiteConfig.parse({});
}
const weeksDir = join(data, "weeks");
const weeks: SiteWeek[] = [];
for (const file of readdirSync(weeksDir).filter((f) => f.endsWith(".json")).sort()) {
  const text = read(join(weeksDir, file));
  problems.push(...leakProblems(`weeks/${file}`, text));
  const parsed = SiteWeek.safeParse(JSON.parse(text));
  if (!parsed.success) {
    problems.push(`weeks/${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    continue;
  }
  for (const d of parsed.data.dishes) {
    if (d.fromText) continue;
    for (const p of recipeProblems(d.recipe)) console.warn(`warning: ${file} ${d.name}: ${p}`);
  }
  weeks.push(parsed.data);
}
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

const root = new URL("../../site/", import.meta.url).pathname;
const assets = Object.fromEntries(readdirSync(root).map((f) => [f, read(join(root, f))]));
const files = buildSite(config, weeks, assets);
rmSync(values.out, { recursive: true, force: true });
for (const [path, content] of files) {
  const target = join(values.out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`${files.size} files, ${weeks.length} weeks, in ${values.out}`);
