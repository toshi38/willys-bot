import type { Dish, PantryItem, Store, WeekItem } from "../src/core/store.ts";
import { messageLanguage } from "../src/plan/inbox.ts";
import type { Product } from "../test/integration/harness.ts";

// What food-bot's message handling is measured on: one member message
// against a seeded week, then checks on what changed. Most scenarios come
// from things that went wrong for real; `about` says which.

export const CATALOG: Product[] = [
  { code: "BEEF_KG", name: "Högrev Nötkött ca 1.2kg", price: 119, offer: true },
  { code: "BEANS_ST", name: "Kidneybönor Ekologiska 380g", price: 12.9 },
  { code: "TOFU_ST", name: "Tofu Fast Naturell Ekologisk 400g", price: 25.9, offer: true },
  { code: "ZUCCHINI_ST", name: "Zucchini Klass 1 ca 360g", price: 11.9 },
  { code: "CHICKEN_BREAST_KG", name: "Kyckling Bröstfilé Sverige ca 900g", price: 143 },
  { code: "CHICKEN_THIGH_ST", name: "Kycklinglårfilé 700g", price: 67.9, offer: true },
  { code: "SWEETPOTATO_KG", name: "Sötpotatis Klass 1 ca 250g", price: 14.9, offer: true },
  { code: "LEEK_KG", name: "Purjolök Klass 1 ca 360g", price: 14.9 },
  { code: "BUTTERNUT_KG", name: "Butternutpumpa hel ca 1kg", price: 14.9, offer: true },
  { code: "LIME_ST", name: "Lime Styck", price: 2 },
  { code: "COCONUT_ST", name: "Kokosmjölk 400ml", price: 14.9 },
  { code: "CURRYPASTE_ST", name: "Röd Currypasta Glutenfri 112g", price: 24.9 },
  { code: "ONION_KG", name: "Lök Gul Klass 1 ca 175g", price: 10.9 },
  { code: "GARLIC_ST", name: "Vitlök Kapsel 100g", price: 9.9 },
  { code: "GINGER_KG", name: "Ingefära ca 120g", price: 59.9 },
  { code: "MUSHROOM_ST", name: "Champinjoner 250g", price: 9.9, offer: true },
  { code: "POTATO_ST", name: "Potatis Fast Klass 1 2kg", price: 24.9 },
  { code: "BANANA_KG", name: "Banan Klass 1 ca 180g", price: 19.9 },
  { code: "DISHPOWDER_ST", name: "Classic Power Powder Maskindiskmedel 1,5kg", price: 56.9 },
  { code: "DISHCLEAN_ST", name: "Deep Cleaner Dishwasher Maskinrengöring 250ml", price: 26.5 },
  { code: "MILK_ST", name: "Mellanmjölk Laktosfri 1,5% 1,5l", price: 18.9 },
  { code: "CHILI_ST", name: "Chili Flakes Burk 28g", price: 23.56 },
  { code: "SKYR_ST", name: "Naturell Skyr Eko 0,2% 400g", price: 18.9 },
  { code: "KVARG_ST", name: "Vanilj Mild Kvarg 0,2% 1kg", price: 39.9 },
  { code: "KVARG_GARANT_ST", name: "Päron Kvarg 0,2% 900g Garant", price: 29.9 },
  { code: "COFFEE_ST", name: "Bryggkaffe Mellanrost 450g", price: 54.9 },
  { code: "SOY_ST", name: "Japansk Soja 150ml", price: 24.9, ingredients: "Vatten, SOJABÖNOR 26%, salt, socker, VETE 12% (GLUTEN), smakförstärkare: E621." },
  { code: "TAMARI_ST", name: "Tamari Glutenfri Soja 150ml", price: 34.9, ingredients: "Vatten, SOJABÖNOR 32%, salt, alkohol.", labels: ["Sånär Fri Från Gluten"] },
  { code: "CUMIN_ELDORADO_ST", name: "Spiskummin Malen Påse 50g", price: 12.9, brand: "Eldorado", category: ["Skafferi", "Kryddor & smaksättare", "Kryddor"] },
  { code: "CUMIN_SANTAMARIA_ST", name: "Spiskummin Malen Burk 33g", price: 26.9, brand: "Santa Maria", category: ["Skafferi", "Kryddor & smaksättare", "Kryddor"] },
  { code: "CHILICRISP_ST", name: "Crispy Chili In Oil 210g", price: 44.9, brand: "Laoganma", ingredients: "SOJAolja [45%], chili [25%], lök [15%], fermenterade sojabönor [SOJABÖNOR, vatten], smakförstärkare: [E621], salt, socker, Sichuan pepparpulver." },
  { code: "TOMATO_ELDORADO_ST", name: "Krossade Tomater 500g", price: 9.9, brand: "Eldorado", category: ["Skafferi", "Konserver"] },
];

export const PREFERENCES = `# Food preferences

## Who and how we cook
- Two adults who meal prep at the weekend: 3 big dishes of about 6 portions each.

## Celiac: strict
- Carin has celiac disease. Everything must be gluten free. "May contain traces of gluten" counts as not gluten free.

## Taste
- Strong flavours, food from around the world. High protein, low calorie.
- Never coriander. Never frozen broccoli.

## Brands
- Avoid Garant and Eldorado unless other brands cost more than double.

## Shopping
- Always in the fridge: milk, skyr, and flavoured kvarg for Stephen (big 1 kg packs).
- Skyr: Carin eats half a 400 g pack a day.
`;

// The week every scenario starts from: three dishes, the members' requests,
// dish ingredients and basics.
export const DISHES = [
  { key: "chili", name: "Slow-cooked beef chili with mushrooms and kidney beans" },
  { key: "stirfry", name: "Chicken, tofu and zucchini stir fry" },
  { key: "braise", name: "Asian braised beef with sweet potato and leek" },
] as const;

export const ITEMS: { code: string; qty: number; source: WeekItem["source"]; dish?: (typeof DISHES)[number]["key"]; by?: string; reason: string }[] = [
  { code: "BANANA_KG", qty: 5, source: "request", by: "Stephen", reason: "Bananas from the list" },
  { code: "DISHPOWDER_ST", qty: 1, source: "request", by: "Stephen", reason: "Dishwasher powder from the list" },
  { code: "DISHCLEAN_ST", qty: 1, source: "request", by: "Carin", reason: "Dishwasher cleaner from the list" },
  { code: "MILK_ST", qty: 2, source: "request", by: "Carin", reason: "Milk from the list" },
  { code: "SKYR_ST", qty: 1, source: "request", by: "Carin", reason: "Skyr" },
  { code: "CHILI_ST", qty: 1, source: "request", by: "Carin", reason: "Chili flakes from the list" },
  { code: "BEEF_KG", qty: 1, source: "dish", dish: "chili", reason: "Beef for the chili" },
  { code: "BEANS_ST", qty: 2, source: "dish", dish: "chili", reason: "Beans for the chili" },
  { code: "TOFU_ST", qty: 2, source: "dish", dish: "stirfry", reason: "Tofu for the stir fry" },
  { code: "ZUCCHINI_ST", qty: 3, source: "dish", dish: "stirfry", reason: "Zucchini for the stir fry" },
  { code: "CHICKEN_BREAST_KG", qty: 1, source: "dish", dish: "stirfry", reason: "Chicken for the stir fry" },
  { code: "BEEF_KG", qty: 1, source: "dish", dish: "braise", reason: "Beef for the braise" },
  { code: "SWEETPOTATO_KG", qty: 4, source: "dish", dish: "braise", reason: "Sweet potato for the braise" },
  { code: "LEEK_KG", qty: 2, source: "dish", dish: "braise", reason: "Leek for the braise" },
  { code: "ONION_KG", qty: 6, source: "staple", reason: "Onions for all dishes" },
  { code: "GARLIC_ST", qty: 2, source: "staple", reason: "Garlic for all dishes" },
  { code: "GINGER_KG", qty: 1, source: "staple", reason: "Ginger for the stir fry and braise" },
  { code: "MUSHROOM_ST", qty: 5, source: "staple", reason: "Mushrooms for the chili and stir fry" },
];

export interface Snapshot {
  items: WeekItem[];
  dishes: Dish[];
  pantry: PantryItem[];
  list: { text: string; status: string }[];
  preferences: string;
}

export interface Seen {
  before: Snapshot;
  after: Snapshot;
  reply: string;
  redraft: string;
}

export interface Scenario {
  name: string;
  // Where the scenario comes from.
  about: string;
  // The week's state: waiting for a decision, approved with the order not
  // yet placed or already placed, or no week at all.
  week: "open" | "approved" | "placed" | "none" | "past";
  from: "Carin" | "Stephen";
  text: string;
  thread?: { from: string; text: string }[];
  // Changes to the household's plan settings, such as more suggestions
  // than meals so the household picks dishes.
  plan?: Record<string, unknown>;
  // Everything that is wrong with the outcome; empty means it passed.
  check: (s: Seen, store: Store) => string[];
}

// Checks that compose.
const code = (s: Snapshot, c: string) => s.items.filter((i) => i.productCode === c);
const qty = (s: Snapshot, c: string) => code(s, c).reduce((n, i) => n + i.qty, 0);
const dishNames = (s: Snapshot) => s.dishes.map((d) => d.name);

function onlyChanged(s: Seen, codes: string[]): string[] {
  const key = (i: WeekItem) => `${i.productCode}:${i.qty}:${i.source}:${i.dishId ?? ""}`;
  const before = s.before.items.filter((i) => !codes.includes(i.productCode)).map(key).sort();
  const after = s.after.items.filter((i) => !codes.includes(i.productCode)).map(key).sort();
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`items other than ${codes.join(", ")} changed`];
}

function dishesKept(s: Seen, except: string[] = []): string[] {
  const missing = s.before.dishes.filter((d) => !except.some((e) => d.name.includes(e)) && !dishNames(s.after).includes(d.name));
  return missing.length ? [`dishes dropped: ${missing.map((d) => d.name).join(", ")}`] : [];
}

function language(s: Seen, want: "English" | "Swedish"): string[] {
  return messageLanguage(s.reply) === want ? [] : [`replied in ${messageLanguage(s.reply)}, not ${want}: "${s.reply.slice(0, 80)}"`];
}

function noRedraft(s: Seen): string[] {
  return s.redraft ? [`asked for a redraft: "${s.redraft.slice(0, 80)}"`] : [];
}

function unchanged(s: Seen): string[] {
  return [...onlyChanged(s, []), ...dishesKept(s), ...(s.before.dishes.length !== s.after.dishes.length ? ["dishes changed"] : [])];
}

// The past week's curry and its ratings, for the rating scenarios.
function curryRatings(store: Store): { member: string; stars: number; comment: string | null }[] {
  for (const w of store.weeks(10)) {
    const dish = store.dishes(w.id).find((d) => /curry/i.test(d.name));
    if (dish) return store.dishRatings(dish.id).map((r) => ({ member: r.member, stars: r.stars, comment: r.comment }));
  }
  return [];
}

export const SCENARIOS: Scenario[] = [
  {
    name: "pick-by-name",
    about: "With six suggestions a week the household picks the dishes to cook (1 Nov)",
    week: "open",
    from: "Carin",
    plan: { suggestions: 6 },
    text: "Let's go with the chili and the braised beef this week.",
    check: (s) => {
      const picked = s.after.dishes.filter((d) => d.pickedBy !== null).map((d) => d.name);
      const want = DISHES.filter((d) => d.key !== "stirfry").map((d) => d.name);
      return [
        ...(JSON.stringify(picked.sort()) === JSON.stringify([...want].sort()) ? [] : [`picked ${JSON.stringify(picked)}, not the chili and the braise`]),
        ...unchanged(s),
        ...noRedraft(s),
        ...language(s, "English"),
      ];
    },
  },
  {
    name: "rate-in-words",
    about: "Ratings feed the planner; members say how a dish was in their own words (1 Nov)",
    week: "past",
    from: "Carin",
    text: "The coconut curry last week was amazing, but a bit too much lime for me.",
    check: (s, store) => {
      const r = curryRatings(store);
      return [
        ...(r.length === 1 && r[0]!.member === "Carin" && r[0]!.stars >= 4 ? [] : [`ratings ${JSON.stringify(r)}, not one of 4 or 5 from Carin`]),
        ...(r[0]?.comment && /lime/i.test(r[0].comment) ? [] : ["the comment about the lime is not recorded"]),
        ...noRedraft(s),
        ...language(s, "English"),
      ];
    },
  },
  {
    name: "rate-survey-reply",
    about: "A reply to the survey gives scores by the dishes' numbers (1 Nov)",
    week: "past",
    from: "Stephen",
    text: "1: 3, bit bland, needed more chili",
    thread: [{ from: "food-bot", text: "How was the food from last Friday?\n1. Coconut chicken and butternut curry\nReply with a score from 1 to 5 for each dish you cooked." }],
    check: (s, store) => {
      const r = curryRatings(store);
      return [
        ...(r.length === 1 && r[0]!.member === "Stephen" && r[0]!.stars === 3 ? [] : [`ratings ${JSON.stringify(r)}, not a 3 from Stephen`]),
        ...(r[0]?.comment && /bland|chili/i.test(r[0].comment) ? [] : ["the comment is not recorded"]),
        ...noRedraft(s),
      ];
    },
  },
  {
    name: "quantity-change",
    about: "Carin asked for 2 skyr and a later revision lost it (20 Oct)",
    week: "open",
    from: "Carin",
    text: "Can we have 2 skyr this week instead of 1?",
    check: (s) => [...(qty(s.after, "SKYR_ST") === 2 ? [] : [`skyr is ${qty(s.after, "SKYR_ST")}, not 2`]), ...onlyChanged(s, ["SKYR_ST"]), ...dishesKept(s), ...noRedraft(s), ...language(s, "English")],
  },
  {
    name: "remove-requests-after-approval",
    about: "\"remove the bananas and the dishwasher stuff\" after approval was told no week existed (29 Oct)",
    week: "approved",
    from: "Stephen",
    text: "remove the bananas and the dishwasher stuff",
    check: (s) => [
      ...["BANANA_KG", "DISHPOWDER_ST", "DISHCLEAN_ST"].flatMap((c) => (qty(s.after, c) ? [`${c} still in the week`] : [])),
      ...onlyChanged(s, ["BANANA_KG", "DISHPOWDER_ST", "DISHCLEAN_ST"]),
      ...dishesKept(s),
      ...noRedraft(s),
      ...language(s, "English"),
      ...(/no week|not planned|inget att ta bort/i.test(s.reply) ? ["said there was no week"] : []),
    ],
  },
  {
    name: "english-in-swedish-thread",
    about: "An English request in a Swedish thread got a Swedish answer (29 Oct)",
    week: "approved",
    from: "Stephen",
    text: "also carin wants a weeks worth of skyr",
    thread: [
      { from: "Carin", text: "Vi behöver mer mjölk och ägg" },
      { from: "food-bot", text: "Jag har lagt till mjölk i veckans order." },
    ],
    check: (s) => [...(qty(s.after, "SKYR_ST") >= 3 ? [] : [`skyr is ${qty(s.after, "SKYR_ST")}, expected at least 3 for a week`]), ...onlyChanged(s, ["SKYR_ST"]), ...language(s, "English")],
  },
  {
    name: "swedish-message",
    about: "Members write in both languages",
    week: "open",
    from: "Carin",
    text: "Kan vi ta bort zucchinin? Vi har redan två hemma.",
    check: (s) => [...(qty(s.after, "ZUCCHINI_ST") ? ["zucchini still in the week"] : []), ...onlyChanged(s, ["ZUCCHINI_ST"]), ...dishesKept(s), ...language(s, "Swedish")],
  },
  {
    name: "swap-one-dish",
    about: "Swapping a dish replaced every dish (20 Oct); Carin's curry swap (29 Oct)",
    week: "open",
    from: "Stephen",
    text: "Carin wants to swap the Asian braised beef for a coconut chicken and butternut curry with rice. Keep everything else.",
    check: (s, store) => {
      const out: string[] = [];
      if (dishNames(s.after).some((n) => n.includes("braised"))) out.push("the braise is still there");
      const curry = s.after.dishes.find((d) => /curry/i.test(d.name));
      if (!curry) out.push("no curry dish");
      else {
        const recipe = curry.recipeId ? store.recipe(curry.recipeId) : null;
        if (!recipe) out.push("the curry has no recipe");
        else if (!recipe.structured) out.push("the curry's recipe has no steps");
        else if (!recipe.structured.steps.some((st) => st.uses.some((u) => /rice|ris/i.test(recipe.structured!.ingredients.find((i) => i.id === u.ingredient)?.name ?? "")) && /rice|ris/i.test(st.text) && st.timer)) out.push("no step cooks the rice");
        if (!s.after.items.some((i) => i.dishId === curry.id)) out.push("nothing bought for the curry");
      }
      if (qty(s.after, "SWEETPOTATO_KG") || qty(s.after, "LEEK_KG")) out.push("the braise's sweet potato or leek is still bought");
      for (const c of ["BANANA_KG", "DISHPOWDER_ST", "DISHCLEAN_ST", "MILK_ST", "SKYR_ST", "CHILI_ST"]) if (qty(s.after, c) !== qty(s.before, c)) out.push(`request ${c} changed`);
      out.push(...dishesKept(s, ["braised"]), ...noRedraft(s), ...language(s, "English"));
      return out;
    },
  },
  {
    name: "add-without-touching-dishes",
    about: "\"Just add things\" changed the recipes (20 Oct: \"we don't have to change the recipes\")",
    week: "open",
    from: "Carin",
    text: "We need some more potatoes too, just add them, don't change the dishes.",
    check: (s) => [...(qty(s.after, "POTATO_ST") >= 1 ? [] : ["no potatoes added"]), ...onlyChanged(s, ["POTATO_ST"]), ...dishesKept(s), ...(s.after.dishes.length === 3 ? [] : ["dish count changed"]), ...noRedraft(s)],
  },
  {
    name: "whole-new-plan",
    about: "Asking for all new dishes should redraft, not edit row by row",
    week: "open",
    from: "Stephen",
    text: "None of these dishes sound good this week, can you come up with three completely different ones?",
    check: (s) => [...(s.redraft ? [] : ["did not ask for a redraft"]), ...unchanged(s)],
  },
  {
    name: "order-already-placed",
    about: "Changes after the order is placed must point to willys.se (29 Oct)",
    week: "placed",
    from: "Stephen",
    text: "add a vanilla kvarg please",
    check: (s) => [
      ...(/willys/i.test(s.reply) ? [] : ["reply does not send them to willys.se"]),
      ...(/(cart|kundvagn)[^.]*(updated|uppdaterad)/i.test(s.reply) ? ["claims the cart was updated"] : []),
      ...language(s, "English"),
    ],
  },
  {
    name: "kvarg-brand-rule",
    about: "Stephen's kvarg: big packs, no Garant unless half the price (29 Oct)",
    week: "approved",
    from: "Stephen",
    text: "and I need a fruit or vanilla kvarg",
    check: (s) => [
      ...(qty(s.after, "KVARG_ST") >= 1 ? [] : ["no Arla 1 kg vanilla kvarg"]),
      ...(qty(s.after, "KVARG_GARANT_ST") ? ["bought the Garant kvarg"] : []),
      ...onlyChanged(s, ["KVARG_ST", "KVARG_GARANT_ST"]),
    ],
  },
  {
    name: "pantry-not-list",
    about: "Running out goes in the pantry, not this week's shop",
    week: "open",
    from: "Carin",
    text: "We're almost out of coffee",
    check: (s) => {
      const coffee = s.after.pantry.find((p) => /coffee|kaffe/i.test(p.name));
      return [...(coffee && coffee.status !== "have" ? [] : ["coffee not marked low or out in the pantry"]), ...onlyChanged(s, ["COFFEE_ST"]), ...dishesKept(s)];
    },
  },
  {
    name: "preference-update",
    about: "Preferences change by message and must keep the celiac rules",
    week: "open",
    from: "Carin",
    text: "Please remember that I don't like celery at all.",
    check: (s) => [
      ...(/celery|selleri/i.test(s.after.preferences) ? [] : ["celery not in the preferences"]),
      ...(/celiac/i.test(s.after.preferences) && /traces of gluten/i.test(s.after.preferences) ? [] : ["celiac rules lost from the preferences"]),
      ...unchanged(s),
    ],
  },
  {
    name: "gluten-rule",
    about: "Soy sauce usually has wheat; Carin has celiac disease",
    week: "open",
    from: "Stephen",
    text: "Add a bottle of soy sauce for the stir fry please.",
    check: (s) => {
      return [
        ...(code(s.after, "SOY_ST").length ? ["added the soy sauce with wheat in its ingredients"] : []),
        ...(qty(s.after, "TAMARI_ST") || code(s.after, "SOY_ST").length ? [] : ["no soy sauce added"]),
        ...onlyChanged(s, ["SOY_ST", "TAMARI_ST"]),
        ...dishesKept(s),
      ];
    },
  },
  {
    name: "own-gluten-request",
    about: "The gluten rule is for Carin's food; Stephen may buy wheat for himself (11 Nov)",
    week: "open",
    from: "Stephen",
    text: "Add a bottle of the Japansk Soja for my own lunches please, I know it has wheat, it's just for me.",
    check: (s) => [
      ...(code(s.after, "SOY_ST").length ? [] : ["did not add the soy sauce Stephen asked for himself"]),
      ...onlyChanged(s, ["SOY_ST"]),
      ...dishesKept(s),
    ],
  },
  {
    name: "ingredient-question",
    about: "Willys lists ingredients; the bot must read them rather than send Carin to the jar (8 Nov)",
    week: "open",
    from: "Carin",
    text: "Willys listar ingredienser under Innehållsförteckning så kolla där. Innehåller Laoganma chilioljan vete?",
    check: (s) => [
      ...(/sojab|soja|soy/i.test(s.reply) ? [] : ["reply does not say what the ingredients are"]),
      ...(/(kolla|läs|check|read)[^.]*(burk|etikett|jar|label)/i.test(s.reply) ? ["sent Carin to the jar instead of answering"] : []),
      ...language(s, "Swedish"),
      ...noRedraft(s),
      ...unchanged(s),
    ],
  },
  {
    name: "past-week-recipe",
    about: "After pickup food-bot said no week was planned and offered new food instead of the recipe (31 Oct)",
    week: "past",
    from: "Carin",
    text: "What was the recipe for the coconut chicken curry we got last week?",
    check: (s) => [
      ...(/butternut/i.test(s.reply) && /lime/i.test(s.reply) ? [] : ["reply does not give the curry's recipe"]),
      ...noRedraft(s),
      ...language(s, "English"),
    ],
  },
  {
    name: "brand-in-category",
    about: "\"Don't get Eldorado spices\": a brand avoided in one category only",
    week: "open",
    from: "Stephen",
    text: "Add some ground cumin for the chili, and a pack of crushed tomatoes.",
    check: (s) => [
      ...(qty(s.after, "CUMIN_ELDORADO_ST") ? ["bought the Eldorado cumin"] : []),
      ...(qty(s.after, "CUMIN_SANTAMARIA_ST") ? [] : ["no cumin added"]),
      ...(qty(s.after, "TOMATO_ELDORADO_ST") ? [] : ["no crushed tomatoes added (Eldorado tomatoes are allowed)"]),
      ...onlyChanged(s, ["CUMIN_ELDORADO_ST", "CUMIN_SANTAMARIA_ST", "TOMATO_ELDORADO_ST"]),
    ],
  },
  {
    name: "question-only",
    about: "A question must not change anything",
    week: "open",
    from: "Stephen",
    text: "What are we eating this week?",
    check: (s) => [...unchanged(s), ...noRedraft(s), ...(/chili/i.test(s.reply) && /stir/i.test(s.reply) ? [] : ["reply does not list the dishes"])],
  },
];
