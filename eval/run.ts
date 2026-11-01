import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FakeWillys } from "../test/integration/harness.ts";
import { CATALOG, PREFERENCES, SCENARIOS } from "./scenarios.ts";

// food-bot's evals: each scenario sends one member message through the real
// intake with the real Claude, against a seeded week and a fake Willys, and
// checks what changed. Each scenario runs several times, since the model is
// not deterministic; the report is a pass rate per scenario, with cost and
// time, so models and prompt changes can be compared.
//
//   npm run eval -- --model haiku --runs 3
//   npm run eval -- --model sonnet --only swap-one-dish,quantity-change

const MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const ROOT = new URL("../", import.meta.url).pathname;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "sonnet" },
    runs: { type: "string", default: "3" },
    only: { type: "string" },
    parallel: { type: "string", default: "4" },
  },
});
const model = MODELS[values.model!] ?? values.model!;
const runs = Number(values.runs);
const scenarios = values.only ? SCENARIOS.filter((s) => values.only!.split(",").includes(s.name)) : SCENARIOS;
if (!scenarios.length) throw new Error(`No scenarios match ${values.only}`);

const base = mkdtempSync(join(tmpdir(), "wb-eval-"));
const catalog = join(base, "catalog.json");
writeFileSync(catalog, JSON.stringify(CATALOG));
const willys = new FakeWillys(CATALOG);
await willys.start();

interface Result {
  name: string;
  pass: boolean;
  failures: string[];
  reply: string;
  redraft: string;
  ms: number;
  costUsd: number | null;
}

async function runOne(name: string, n: number): Promise<Result> {
  const dir = join(base, `${name}-${n}`);
  const households = join(dir, "households");
  mkdirSync(join(households, "eval"), { recursive: true });
  writeFileSync(
    join(households, "eval", "household.json"),
    JSON.stringify({
      name: "Eval household",
      willys: { storeId: "9999", secret: "eval-willys" },
      pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" },
      members: [
        { name: "Carin", email: "carin@test.example" },
        { name: "Stephen", email: "stephen@test.example" },
      ],
      mail: { address: "food@test.example", name: "food-bot", secret: "eval-resend" },
      plan: { meals: 3, portionsPerMeal: 6, people: 2, budgetSek: 1200, language: "en" },
      rules: { avoidBrands: ["Garant"], avoid: [{ brand: "Eldorado", category: "spices", strict: true }], glutenFree: true, staples: [] },
    }),
  );
  writeFileSync(join(households, "eval", "preferences.md"), PREFERENCES);
  const usage = join(dir, "usage.jsonl");
  writeFileSync(usage, "");
  const env = {
    ...process.env,
    WILLYS_BOT_HOUSEHOLDS: households,
    WILLYS_BOT_DATA: join(dir, "data"),
    WILLYS_BOT_MODEL: model,
    WILLYS_BOT_USAGE_LOG: usage,
    WILLYS_BASE_URL: willys.url,
    WILLYS_MIN_INTERVAL_MS: "0",
    EVAL_CATALOG: catalog,
  };
  const out = await new Promise<string>((resolve) =>
    execFile(process.execPath, ["--no-warnings=ExperimentalWarning", join(ROOT, "eval/run-one.ts"), name], { env, timeout: 15 * 60_000, maxBuffer: 10_000_000 }, (err, stdout, stderr) =>
      resolve(err && !stdout.trim() ? JSON.stringify({ name, pass: false, failures: [`crashed: ${(stderr || String(err)).slice(0, 300)}`], reply: "", redraft: "", ms: 0 }) : stdout),
    ),
  );
  const result = JSON.parse(out.trim().split("\n").at(-1)!) as Result;
  const costs = readFileSync(usage, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { costUsd: number | null }).costUsd ?? 0);
  result.costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  rmSync(dir, { recursive: true, force: true });
  process.stderr.write(result.pass ? "." : "F");
  return result;
}

// A small pool, so a full run does not take an hour.
const jobs = scenarios.flatMap((s) => Array.from({ length: runs }, (_, n) => () => runOne(s.name, n)));
const results: Result[] = [];
const limit = Number(values.parallel);
await Promise.all(
  Array.from({ length: limit }, async () => {
    while (jobs.length) results.push(await jobs.shift()!());
  }),
);
process.stderr.write("\n");
willys.stop();

const rows = scenarios.map((s) => {
  const mine = results.filter((r) => r.name === s.name);
  const passed = mine.filter((r) => r.pass).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return { scenario: s.name, passed, runs: mine.length, avgSeconds: avg(mine.map((r) => r.ms)) / 1000, avgCostUsd: avg(mine.map((r) => r.costUsd ?? 0)), failures: [...new Set(mine.flatMap((r) => r.failures))] };
});
const total = rows.reduce((n, r) => n + r.passed, 0);
console.log(`\n${model}: ${total}/${results.length} runs passed\n`);
console.log(`${"scenario".padEnd(32)} pass   avg s   avg $`);
for (const r of rows) console.log(`${r.scenario.padEnd(32)} ${`${r.passed}/${r.runs}`.padEnd(6)} ${r.avgSeconds.toFixed(0).padStart(5)}   ${r.avgCostUsd.toFixed(3)}`);
for (const r of rows.filter((r) => r.failures.length)) console.log(`\n${r.scenario}:\n${r.failures.map((f) => `  - ${f}`).join("\n")}`);

const resultsDir = join(ROOT, "eval/results");
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${values.model}.json`);
writeFileSync(file, JSON.stringify({ model, runs, rows, results }, null, 2));
console.log(`\nDetails: ${file}`);
rmSync(base, { recursive: true, force: true });
