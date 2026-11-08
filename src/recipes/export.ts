import type { Store } from "../core/store.ts";
import { fromText } from "./legacy.ts";
import type { SiteWeek } from "./site.ts";

// A week's dishes as the recipe site reads them (site-data/weeks/<pickup>.json):
// the structured recipe where there is one, else the text recipe read as
// steps. Dishes without a recipe are left out.
export function siteWeek(store: Store, pickup: string): SiteWeek {
  const dishes = store.dishes(pickup).flatMap((d) => {
    const r = d.recipeId ? store.recipe(d.recipeId) : null;
    if (!r) return [];
    const recipe = r.structured ?? fromText({ name: r.name, servings: r.servings, ingredients: r.ingredients, method: r.method, notes: r.notes });
    return [{ name: d.name, portions: d.portions, recipe, fromText: !r.structured }];
  });
  return { pickup, dishes };
}
