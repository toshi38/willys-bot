import type { Recipe } from "./recipe.ts";

// A short recipe that passes recipeProblems, for tests that need a dish
// with a valid recipe.
export function sampleRecipe(servings: number, main = "chicken"): Recipe {
  return {
    name: `${main} stew`,
    servings,
    summary: `A ${main} stew with rice`,
    equipment: ["pot", "saucepan with lid"],
    ingredients: [
      { id: "main", name: main, qty: 700, unit: "g" },
      { id: "onion", name: "onion", qty: 1, prep: "chopped" },
      { id: "rice", name: "rice", qty: 4, unit: "dl", fromPantry: true },
    ],
    steps: [
      { id: "chop", kind: "prep", text: "Chop the onion.", uses: [{ ingredient: "onion", becomes: "chopped onion" }], minutes: 3 },
      { id: "brown", kind: "cook", text: `Brown the ${main} with the onion.`, uses: [{ ingredient: "main", becomes: `browned ${main}` }, { ingredient: "onion" }], minutes: 2, timer: { minutes: 6, label: "Brown" }, heat: "high" },
      { id: "stew", kind: "simmer", text: "Add 3 dl water and simmer until tender.", uses: [{ ingredient: "main" }], minutes: 1, timer: { minutes: 20, label: "Stew" }, passive: true, heat: "low", after: ["brown"] },
      { id: "rice", kind: "simmer", text: "Cook the rice in 6 dl water, covered, on low.", uses: [{ ingredient: "rice" }], minutes: 3, timer: { minutes: 20, label: "Rice" }, passive: true, heat: "low" },
      { id: "serve", kind: "serve", text: "Serve the stew with the rice.", uses: [{ ingredient: "rice" }], minutes: 2, after: ["stew", "rice"] },
    ],
  };
}
