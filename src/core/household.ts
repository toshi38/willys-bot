import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// A household is one Willys account shopped for by a group of people. Each
// lives in households/<id>/ with household.json (validated here) and
// preferences.md (free text the planner reads). Real households are
// gitignored; households/example/ shows the format.

const Time = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");
const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const Person = z.object({
  name: z.string(),
  email: z.string().email(),
  // Tailscale login names that identify this person in the web UI, when
  // they differ from the email address.
  tailscale: z.array(z.string()).default([]),
});

export const HouseholdConfig = z.object({
  name: z.string(),
  willys: z.object({
    storeId: z.string(),
    // Keychain service (Mac) or systemd credential prefix (XPS) holding the
    // "username" and "password" entries.
    secret: z.string(),
  }),
  pickup: z.object({
    weekdays: z.array(Weekday).min(1),
    earliest: Time,
    latest: Time,
  }),
  // Who may add to the list and approve orders. Approval replies are only
  // accepted from these addresses.
  members: z.array(Person).min(1),
  mail: z.object({
    // The bot's own address, on a domain Resend sends and receives for.
    // Plans go out from it and members write to it.
    address: z.string().email(),
    name: z.string().default("food-bot"),
    // Keychain service (Mac) or systemd credential prefix (XPS) holding the
    // Resend API key as account "key". The key needs full access: reading
    // received email is not part of a sending-only key.
    secret: z.string(),
  }),
  // Set when the household also uses Slack through slack-gateway: plans are
  // posted there with Approve and Skip buttons, and the bot's channel works
  // like its email address. `bot` is the gateway's id for food-bot.
  slack: z.object({ bot: z.string().default("food") }).optional(),
  // Who hears about failed runs. Defaults to the first member.
  operator: z.string().email().optional(),
  // Rules code enforces on every product bought, whatever the model
  // decides (see core/rules.ts), and standing orders added to every week.
  rules: z
    .object({
      // Brands avoided everywhere, e.g. ["Garant"]: shorthand for avoid
      // rules with only a brand.
      avoidBrands: z.array(z.string()).default([]),
      // Products bought only with a stated exception. Every field a rule
      // gives must match: a brand, words in the product name, a category
      // (Willys's, in Swedish or a few English words like "spices"), or one
      // product code. Strict rules allow no exception.
      avoid: z
        .array(
          z
            .object({
              brand: z.string().optional(),
              name: z.string().optional(),
              category: z.string().optional(),
              product: z.string().optional(),
              strict: z.boolean().default(false),
              note: z.string().optional(),
            })
            .refine((r) => r.brand || r.name || r.category || r.product, "an avoid rule needs a brand, name, category or product"),
        )
        .default([]),
      // Products that look like they contain gluten need a stated check.
      glutenFree: z.boolean().default(false),
      // Bought every week unless a member removes them that week.
      staples: z.array(z.object({ name: z.string(), productCode: z.string(), qty: z.number().int().min(1).max(50) })).default([]),
    })
    .default({ avoidBrands: [], avoid: [], glutenFree: false, staples: [] }),
  plan: z.object({
    // Batch-cooked dishes per week and portions of each; a household that
    // cooks every night uses one portion count per dinner instead.
    meals: z.number().int().min(0).max(14),
    // Dishes the planner suggests each week. With more suggestions than
    // meals, the household picks the ones to cook and only those are
    // ordered; otherwise every dish is ordered.
    suggestions: z.number().int().min(0).max(14).optional(),
    // One suggestion a week is a dish from another country's home cooking
    // the household probably does not know.
    wildcard: z.boolean().default(false),
    portionsPerMeal: z.number().int().min(1).default(4),
    people: z.number().int().min(1),
    // Soft weekly budget the planner aims for, in SEK.
    budgetSek: z.number().positive().optional(),
    language: z.enum(["sv", "en"]).default("en"),
  }),
});
export type HouseholdConfig = z.infer<typeof HouseholdConfig>;

export interface Household {
  id: string;
  dir: string;
  config: HouseholdConfig;
  preferences: string;
}

export function householdsDir(): string {
  return (process.env.WILLYS_BOT_HOUSEHOLDS ?? new URL("../../households/", import.meta.url).pathname).replace(/\/$/, "");
}

export function loadHousehold(id: string): Household {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Bad household id: ${id}`);
  const dir = join(householdsDir(), id);
  const configPath = join(dir, "household.json");
  if (!existsSync(configPath)) throw new Error(`No household config at ${configPath}. Copy households/example/ to start one.`);
  const config = HouseholdConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const prefPath = join(dir, "preferences.md");
  const preferences = existsSync(prefPath) ? readFileSync(prefPath, "utf8") : "";
  return { id, dir, config, preferences };
}

// Replaces preferences.md, for changes members ask for by email.
export function savePreferences(household: Household, markdown: string): void {
  writeFileSync(join(household.dir, "preferences.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  household.preferences = markdown;
}

// The household to act on: --household flag, then WILLYS_BOT_HOUSEHOLD.
export function householdId(flag: string | undefined): string {
  const id = flag ?? process.env.WILLYS_BOT_HOUSEHOLD;
  if (!id) throw new Error("Pick a household with --household <id> or WILLYS_BOT_HOUSEHOLD");
  return id;
}

export function isMember(household: Household, email: string): boolean {
  const e = email.trim().toLowerCase();
  return household.config.members.some((m) => m.email.toLowerCase() === e);
}

// The member a Tailscale login belongs to, matched on email or any listed
// Tailscale login.
export function memberByLogin(household: Household, login: string): HouseholdConfig["members"][number] | null {
  const l = login.trim().toLowerCase();
  return household.config.members.find((m) => m.email.toLowerCase() === l || m.tailscale.some((t) => t.toLowerCase() === l)) ?? null;
}

// How many dishes the planner suggests each week.
export function suggestionCount(household: Household): number {
  return Math.max(household.config.plan.suggestions ?? 0, household.config.plan.meals);
}

// True when the household picks some of the suggested dishes each week,
// rather than ordering all of them.
export function picksDishes(household: Household): boolean {
  return suggestionCount(household) > household.config.plan.meals;
}
