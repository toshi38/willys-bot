import { z } from "zod";

// A recipe as the planner writes it, the recipe site shows it and cook mode
// walks through it. Steps are in the order the cook does them, interleaved
// so waiting time (the oven heating, rice cooking, a sauce simmering) is
// spent on the next steps. How to write one well is in
// .claude/skills/recipe-writing/SKILL.md.

export const STEP_KINDS = ["preheat", "prep", "cook", "simmer", "bake", "rest", "assemble", "serve"] as const;

const id = z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and hyphens");

export const Ingredient = z.object({
  id: id.describe('Short id that steps refer to, for example "onion" or "coconut-milk"'),
  name: z.string().min(1).describe('What it is, for example "yellow onion"'),
  qty: z.number().positive().optional().describe("Amount for the whole recipe"),
  unit: z.string().optional().describe('"g", "dl", "st", "tbsp"; leave out for a count'),
  prep: z.string().optional().describe('How it goes into the dish, for example "finely chopped"'),
  group: z.string().optional().describe('A heading when the recipe has parts, for example "For the sauce" or "To serve"'),
  fromPantry: z.boolean().optional().describe("Already at home, so not bought this week"),
});
export type Ingredient = z.infer<typeof Ingredient>;

export const Timer = z.object({
  minutes: z.number().positive().describe("The shortest time it needs"),
  upTo: z.number().positive().optional().describe("The longest time, when it is a range"),
  label: z.string().min(1).describe('Shown on the running timer, for example "Rice" or "Oven to 200°C"'),
});
export type Timer = z.infer<typeof Timer>;

export const Step = z.object({
  id,
  kind: z.enum(STEP_KINDS),
  text: z.string().min(1).describe("One action, with the cue for when it is done"),
  uses: z
    .array(
      z.object({
        ingredient: id,
        qty: z.number().positive().optional().describe("When the step uses only part of it"),
        becomes: z
          .string()
          .optional()
          .describe('What the step turns it into, when a later step uses it again, for example "fried tofu"'),
      }),
    )
    .default([])
    .describe("Ingredients this step uses, shown on the step"),
  minutes: z.number().min(0).describe("Hands-on time for the step"),
  timer: Timer.optional().describe("Something to wait for after the hands-on part"),
  passive: z.boolean().optional().describe("The timer runs on its own and the cook moves on to the next steps"),
  after: z.array(id).optional().describe("Earlier steps that must be finished first, timers included"),
  heat: z.enum(["low", "medium", "high"]).optional(),
  oven: z.object({ celsius: z.number().int().positive(), fan: z.boolean() }).optional(),
});
export type Step = z.infer<typeof Step>;

export const Recipe = z.object({
  name: z.string().min(1),
  servings: z.number().int().positive(),
  summary: z.string().default("").describe("One line about the dish"),
  equipment: z.array(z.string()).default([]),
  ingredients: z.array(Ingredient).min(1),
  steps: z.array(Step).min(2),
  notes: z.string().optional().describe("Leftovers, freezing, swaps"),
});
export type Recipe = z.infer<typeof Recipe>;

// The amount of an ingredient as one string, for example "1400 g" or "2".
export function amount(qty: number | undefined, unit: string | undefined): string {
  if (qty === undefined) return "";
  const n = Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return unit ? `${n} ${unit}` : n;
}

// A recipe as plain text, for the places that show it as text (the bot's
// answers, the web views): one ingredient per line and numbered steps.
export function recipeText(r: Recipe): { ingredients: string; method: string } {
  const ingredients = r.ingredients
    .map((i) => [amount(i.qty, i.unit), i.name].filter(Boolean).join(" ") + (i.prep ? `, ${i.prep}` : "") + (i.fromPantry ? " (pantry)" : ""))
    .join("\n");
  const method = r.steps.map((s, n) => `${n + 1}. ${s.text}`).join("\n");
  return { ingredients, method };
}
