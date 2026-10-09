import { existsSync, readFileSync } from "node:fs";
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
    smtpHost: z.string().default("smtp.gmail.com"),
    smtpPort: z.number().int().default(465),
    imapHost: z.string().default("imap.gmail.com"),
    imapPort: z.number().int().default(993),
    user: z.string(),
    from: z.string(),
    // Keychain service or systemd credential name holding the app password.
    secret: z.string(),
  }),
  plan: z.object({
    dinners: z.number().int().min(0).max(14),
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
