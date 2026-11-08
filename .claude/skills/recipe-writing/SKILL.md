---
name: recipe-writing
description: How to write a food-bot recipe as structured steps for the recipe site and its cook mode (ingredient ids, step kinds, timers, passive steps, the order that uses waiting time). Use when writing, fixing or reviewing a recipe for a household's week, or when changing the recipe format in src/recipes/.
---

# Writing a recipe

A recipe is cooked from a phone, one step at a time, by someone who has not read it first.
Write it so that following the steps in order is also the fastest way to cook it.

The shape is `Recipe` in `src/recipes/recipe.ts`; `recipeProblems` in `src/recipes/check.ts`
rejects a recipe that breaks the rules below that code can check.

The recipe is the whole meal. Whatever is served with the dish (rice, pasta, potatoes, bread,
a salad) is in the ingredients and has steps that make it, so nothing is "to serve" without
anyone having cooked it.

## Ingredients

- Give every ingredient a short id in English, lowercase with hyphens (`onion`, `coconut-milk`,
  `chicken-thigh`), and a `name` in the household's language.
- Amounts are for the whole recipe, the same portions as the dish. Use `qty` and `unit`
  (`g`, `kg`, `dl`, `ml`, `msk`/`tbsp`, `tsk`/`tsp`, `st` or no unit for a count). Leave `qty`
  out only for "salt to taste" and the like.
- `prep` says how it goes in ("finely chopped", "in 2 cm cubes"), so the ingredient list doubles
  as a prep list. The step that does the prep still says so.
- Use `group` when the dish has parts that are served separately ("To serve", "For the rice").
- Mark what the household already has with `fromPantry: true`.
- Every ingredient is used by at least one step.

## Steps

One action per step: "Chop the onion and garlic" is one step, "chop the onion, then fry it" is
two. The `text` is a full instruction with the cue for when it is done: "Fry the chicken on high
heat until golden on all sides, about 5 minutes."

`kind` is the type of step, which the site shows as an icon and colour:

| kind | for |
| --- | --- |
| `preheat` | Heating the oven. Needs `oven`, a timer and `passive: true`. |
| `prep` | Chopping, grating, measuring, marinating by hand, mixing a sauce. |
| `cook` | Hands-on cooking at the stove: frying, browning, stirring. |
| `simmer` | Something on the hob you leave alone: rice, a stew, pasta water. |
| `bake` | Something in the oven. |
| `rest` | Meat resting, dough rising, a marinade. |
| `assemble` | Putting parts together: filling tacos, layering a lasagne. |
| `serve` | The last step: plating, garnish, what goes on the side. |

- `uses` lists the ingredients the step puts in or works on, by id, so the step card shows them
  with their amounts. When a step uses only part of one ("half the garlic"), give its `qty`.
  When a later step uses it again, give `becomes`: what this step turns it into ("fried
  tofu"). See below.
- `minutes` is hands-on time. Be honest: chopping two onions is 4 minutes, not 1.
- `timer` is anything the cook waits for: `minutes` is the shortest time, `upTo` the longest
  when it is a range, and `label` names it on the running timer ("Rice", "Curry", "Oven
  200°C"). The step's text still says the cue ("until the squash is soft").
- `passive: true` means the timer runs while the cook moves on: rice cooking, the oven heating,
  a stew simmering, chicken in the oven, and browning or frying that only needs a turn every
  few minutes (meat browning in batches, tofu frying): its text says to turn it between the
  next steps. Leave it out for timers the cook stands over (a stir fry tossed all the time,
  onions stirred so they do not catch).
- `after` lists the earlier steps that must be finished, timers included, before this one can
  start: the browned chicken goes back into the sauce after both are done. Use it for every real
  dependency; a step without `after` can be done any time after the steps above it.
- `heat` (`low`, `medium`, `high`) for steps on the hob; `oven` (`celsius`, `fan`) on every step
  that uses the oven, including the preheat.

## Order: use the waiting time

Order the steps so the cook is never standing idle while something cooks:

1. Preheat the oven first, and put on anything slow to get going (a big pot of water). These
   are passive steps with timers.
2. Get something on the heat early. Cut only what goes in first (the meat to brown, the tofu
   to fry), start it as a passive step, and cut the rest while it cooks. Do not cut
   everything before anything is cooking, unless it all goes into the pan at once.
3. Cook the main part, and start the side parts (rice, pasta, potatoes) so they finish with
   it, not half an hour before: rice goes on while the curry simmers.
4. When a step must wait for a timer, put the next unrelated job (washing the salad, mixing the
   dressing, setting the table) into the wait, not after it.
5. Finish with a `serve` step that is `after` every part it brings together.

A step lists the same ingredient again when it works on it again: the onion is chopped in one
step and fried in another. Give `qty` on a step only when it uses part of the ingredient.

The site shows an ingredient's amount only on the first step that uses it. A later step that
lists it again gets it from the last step that used it, and shows "chopped onion from step 1"
instead. So when a step leaves something for later (the browned chicken, the fried tofu, a
sauce), give each of those uses `becomes` (`{ "ingredient": "chicken", "becomes": "browned
chicken" }`), so the later step shows "browned chicken from step 2", and say so in the later
step's text: "Put the browned chicken back in", not "Add the chicken", which reads as raw
chicken from the packet. A part the cook adds fresh in two goes ("half the garlic" now, half
later) has a `qty` on each step, and each shows its own amount.

The checker walks the steps with one cook. It flags a wait of 3 minutes or more where a later
step could have been done instead, a passive part that is ready 10 minutes or more before
the step that needs it, and 8 minutes or more of cutting before anything is on the heat when
some of that cutting is for later.

## Language and style

- `text`, `name`, `prep`, `group`, `label`, `summary` and `notes` are in the household's
  language; ids are English.
- No em dashes or en dashes: use commas, colons or full stops. Write ranges as "25 to 30
  minutes".
- `summary` is one line about the dish ("Mild coconut curry with butternut, ready in 45
  minutes").
- `notes` is for leftovers, freezing and swaps, not for steps.

## Example

```json
{
  "name": "Coconut chicken and butternut curry with rice",
  "servings": 6,
  "summary": "Mild coconut curry with butternut squash and lime",
  "equipment": ["large pot", "saucepan with lid"],
  "ingredients": [
    { "id": "rice", "name": "jasmine rice", "qty": 6, "unit": "dl", "fromPantry": true },
    { "id": "chicken", "name": "chicken thigh fillets", "qty": 1400, "unit": "g", "prep": "in bite-size pieces" },
    { "id": "squash", "name": "butternut squash", "qty": 1, "unit": "kg", "prep": "peeled, in 2 cm cubes" },
    { "id": "onion", "name": "yellow onions", "qty": 2, "prep": "chopped" },
    { "id": "garlic", "name": "garlic cloves", "qty": 4, "prep": "grated" },
    { "id": "ginger", "name": "fresh ginger", "qty": 30, "unit": "g", "prep": "grated" },
    { "id": "coconut-milk", "name": "coconut milk", "qty": 2, "unit": "cans", "fromPantry": true },
    { "id": "lime", "name": "limes", "qty": 2 },
    { "id": "oil", "name": "oil", "qty": 2, "unit": "tbsp" },
    { "id": "salt", "name": "salt" }
  ],
  "steps": [
    { "id": "cut-chicken", "kind": "prep", "text": "Cut the chicken into bite-size pieces.", "uses": [{ "ingredient": "chicken", "becomes": "chicken pieces" }], "minutes": 5 },
    { "id": "brown", "kind": "cook", "text": "Heat the oil in the large pot on high and brown the chicken in two batches, turning the pieces when they come away from the pot, while you cut the vegetables. Lift each batch onto a plate.", "uses": [{ "ingredient": "oil" }, { "ingredient": "chicken", "becomes": "browned chicken" }], "minutes": 2, "timer": { "minutes": 10, "upTo": 12, "label": "Chicken" }, "passive": true, "heat": "high" },
    { "id": "chop", "kind": "prep", "text": "Peel and cube the squash, chop the onions and grate the garlic and ginger.", "uses": [{ "ingredient": "squash", "becomes": "squash cubes" }, { "ingredient": "onion", "becomes": "chopped onion" }, { "ingredient": "garlic", "becomes": "grated garlic" }, { "ingredient": "ginger", "becomes": "grated ginger" }], "minutes": 10 },
    { "id": "soften", "kind": "cook", "text": "Turn the heat to medium and fry the onion, garlic and ginger in the same pot until soft.", "uses": [{ "ingredient": "onion" }, { "ingredient": "garlic" }, { "ingredient": "ginger" }], "minutes": 1, "timer": { "minutes": 4, "upTo": 5, "label": "Onion" }, "after": ["chop", "brown"], "heat": "medium" },
    { "id": "curry", "kind": "simmer", "text": "Add the squash, the coconut milk and the browned chicken. Bring to the boil, then simmer until the squash is soft.", "uses": [{ "ingredient": "squash" }, { "ingredient": "coconut-milk" }, { "ingredient": "chicken", "becomes": "curry" }], "minutes": 1, "timer": { "minutes": 20, "upTo": 25, "label": "Curry" }, "passive": true, "after": ["soften"], "heat": "low" },
    { "id": "rice", "kind": "simmer", "text": "While the curry simmers, rinse the rice, put it in the saucepan with 9 dl water and a pinch of salt, bring to the boil, then cover and simmer on low.", "uses": [{ "ingredient": "rice" }, { "ingredient": "salt" }], "minutes": 3, "timer": { "minutes": 12, "upTo": 15, "label": "Rice" }, "passive": true, "heat": "low" },
    { "id": "finish", "kind": "serve", "text": "Squeeze the lime juice into the curry, add salt to taste and serve with the rice.", "uses": [{ "ingredient": "lime" }, { "ingredient": "salt" }], "minutes": 2, "after": ["curry", "rice"] }
  ],
  "notes": "Freezes well without the rice."
}
```
