import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { householdId, householdsDir, isMember, loadHousehold, memberByLogin, savePreferences } from "./household.ts";

const config = {
  name: "Test household",
  willys: { storeId: "2299", secret: "willys-bot-test-willys" },
  pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" },
  members: [
    { name: "Carin", email: "Carin@lau.engineering", tailscale: ["carin-phone@github"] },
    { name: "Stephen", email: "stephen@lau.engineering" },
  ],
  mail: { address: "food@ai.lau.engineering", secret: "willys-bot-test-resend" },
  plan: { meals: 3, people: 2 },
};

// A households directory with one household per entry, used through
// WILLYS_BOT_HOUSEHOLDS. Each test file runs in its own process, so setting
// the variable here does not reach other tests.
function households(entries: Record<string, { config?: unknown; preferences?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "households-"));
  for (const [id, e] of Object.entries(entries)) {
    mkdirSync(join(dir, id));
    if (e.config !== undefined) writeFileSync(join(dir, id, "household.json"), JSON.stringify(e.config));
    if (e.preferences !== undefined) writeFileSync(join(dir, id, "preferences.md"), e.preferences);
  }
  process.env.WILLYS_BOT_HOUSEHOLDS = `${dir}/`;
  return dir;
}

test("a household loads with its preferences and the config defaults filled in", () => {
  const dir = households({ lau: { config, preferences: "No coriander.\n" } });
  const h = loadHousehold("lau");
  assert.equal(h.id, "lau");
  assert.equal(h.dir, join(dir, "lau"));
  assert.equal(h.preferences, "No coriander.\n");
  assert.equal(h.config.name, "Test household");
  assert.deepEqual(h.config.members[1].tailscale, []);
  assert.equal(h.config.mail.name, "food-bot");
  assert.deepEqual([h.config.plan.portionsPerMeal, h.config.plan.language, h.config.plan.budgetSek], [4, "en", undefined]);
  assert.equal(h.config.slack, undefined);
});

test("a household without preferences.md has empty preferences", () => {
  households({ lau: { config } });
  assert.equal(loadHousehold("lau").preferences, "");
});

test("the households directory comes from WILLYS_BOT_HOUSEHOLDS without a trailing slash", () => {
  const dir = households({});
  assert.equal(householdsDir(), dir);
  delete process.env.WILLYS_BOT_HOUSEHOLDS;
  assert.match(householdsDir(), /\/households$/);
});

test("household ids that could leave the households directory are rejected", () => {
  households({ lau: { config } });
  for (const id of ["../lau", "lau/..", "Lau", "lau household", "", "lau.json"]) {
    assert.throws(() => loadHousehold(id), /Bad household id/, id);
  }
});

test("a missing household says where its config should be", () => {
  const dir = households({});
  assert.throws(() => loadHousehold("nobody"), (err: Error) => err.message.startsWith(`No household config at ${join(dir, "nobody", "household.json")}`));
});

test("an invalid household config is refused", () => {
  const bad = {
    badTime: { config: { ...config, pickup: { ...config.pickup, latest: "8pm" } } },
    noMembers: { config: { ...config, members: [] } },
    badEmail: { config: { ...config, mail: { ...config.mail, address: "food" } } },
    badDay: { config: { ...config, pickup: { ...config.pickup, weekdays: ["friday"] } } },
    tooManyMeals: { config: { ...config, plan: { ...config.plan, meals: 15 } } },
    badLanguage: { config: { ...config, plan: { ...config.plan, language: "de" } } },
  };
  households(Object.fromEntries(Object.entries(bad).map(([k, v]) => [k.toLowerCase(), v])));
  for (const id of Object.keys(bad)) assert.throws(() => loadHousehold(id.toLowerCase()), (err: Error) => err.name === "ZodError", id);
});

test("household.json that is not JSON is refused", () => {
  const dir = households({ lau: {} });
  writeFileSync(join(dir, "lau", "household.json"), "{ name: ");
  assert.throws(() => loadHousehold("lau"), SyntaxError);
});

test("saved preferences end in a newline on disk and are kept as given in memory", () => {
  const dir = households({ lau: { config, preferences: "old" } });
  const h = loadHousehold("lau");
  savePreferences(h, "No fish on Fridays.");
  assert.equal(readFileSync(join(dir, "lau", "preferences.md"), "utf8"), "No fish on Fridays.\n");
  assert.equal(h.preferences, "No fish on Fridays.");
  savePreferences(h, "Less meat.\n");
  assert.equal(readFileSync(join(dir, "lau", "preferences.md"), "utf8"), "Less meat.\n");
  assert.equal(loadHousehold("lau").preferences, "Less meat.\n");
});

test("members are found by email or Tailscale login, ignoring case and spaces", () => {
  households({ lau: { config } });
  const h = loadHousehold("lau");
  assert.equal(memberByLogin(h, " carin@LAU.engineering ")?.name, "Carin");
  assert.equal(memberByLogin(h, "Carin-Phone@GitHub")?.name, "Carin");
  assert.equal(memberByLogin(h, "stephen@lau.engineering")?.name, "Stephen");
  assert.equal(memberByLogin(h, "someone@lau.engineering"), null);
  assert.equal(isMember(h, " CARIN@lau.engineering"), true);
  assert.equal(isMember(h, "carin-phone@github"), false);
});

test("the household to act on is the flag, then WILLYS_BOT_HOUSEHOLD", () => {
  process.env.WILLYS_BOT_HOUSEHOLD = "from-env";
  assert.equal(householdId("from-flag"), "from-flag");
  assert.equal(householdId(undefined), "from-env");
  delete process.env.WILLYS_BOT_HOUSEHOLD;
  assert.throws(() => householdId(undefined), /Pick a household/);
});
