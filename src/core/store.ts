import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Recipe as StructuredRecipe } from "../recipes/recipe.ts";
import type { Product } from "../willys/types.ts";

// SQLite persistence, one database per household: the shared shopping list,
// every price seen (regular and promotional) for sale-price judgement, the
// weekly shops with their dishes, items and recipes, and the saved Willys
// session.

export type ListStatus = "open" | "planned" | "ordered" | "removed";

export interface ListItem {
  id: number;
  text: string;
  quantity: string | null;
  note: string | null;
  productCode: string | null;
  addedBy: string;
  addedAt: string;
  status: ListStatus;
  // The week that ordered it.
  weekId: string | null;
}

export type PantryStatus = "have" | "low" | "out";

export interface PantryItem {
  id: number;
  name: string;
  status: PantryStatus;
  quantity: string | null;
  note: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type PriceKind = "regular" | "online-promo" | "offline-promo";

export interface PriceObservation {
  productCode: string;
  observedOn: string;
  kind: PriceKind;
  price: number;
  comparePrice: string | null;
  label: string | null;
}

export type MailStatus = "handled" | "ignored" | "retry" | "failed";

export interface MailRecord {
  // Resend's id for the received email.
  id: string;
  receivedAt: string;
  sender: string;
  subject: string;
  status: MailStatus;
  attempts: number;
  note: string | null;
  updatedAt: string;
}

export interface SlackMessage {
  id: number;
  at: string;
  channel: string;
  ts: string;
  threadTs: string | null;
  // The member's email, as Slack verified it.
  sender: string;
  name: string;
  kind: "message" | "action";
  // The message, or the button's action id and value.
  text: string;
  reply: string | null;
  error: string | null;
}

export type WeekStatus = "drafting" | "open" | "approved" | "applied" | "skipped" | "failed";

// One weekly shop, keyed by its pickup date. The planner drafts it once;
// after that it changes only through edits to its dishes and items, until a
// member approves or skips it.
export interface Week {
  // Pickup date, YYYY-MM-DD.
  id: string;
  // In every email subject about the week, so a reply finds it.
  token: string;
  status: WeekStatus;
  summary: string;
  notes: string;
  // Bumped by every change to the dishes or items. announcedVersion is the
  // version the household was last shown.
  version: number;
  announcedVersion: number;
  createdAt: string;
  sentAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  error: string | null;
}

export interface Recipe {
  id: number;
  name: string;
  servings: number | null;
  // One ingredient per line.
  ingredients: string;
  method: string;
  notes: string | null;
  // The recipe as ingredients and timed steps, which the recipe site and
  // cook mode show. Recipes saved as text only have none, and their
  // ingredients and method are all there is.
  structured: StructuredRecipe | null;
  createdBy: string;
  updatedAt: string;
}

export interface Dish {
  id: number;
  weekId: string;
  recipeId: number | null;
  name: string;
  portions: number;
  why: string;
  // The country a wildcard dish comes from; null for the others.
  origin: string | null;
  // Who picked the dish to cook this week, for households that pick some
  // of the suggestions (see picksDishes).
  pickedBy: string | null;
  addedBy: string;
  removedAt: string | null;
}

// A member's score for a dish they cooked, 1 to 5, with what they said.
export interface Rating {
  dishId: number;
  recipeId: number | null;
  weekId: string;
  dishName: string;
  member: string;
  stars: number;
  comment: string | null;
  at: string;
}

// How the household has rated a recipe over the weeks.
export interface RecipeRating {
  recipeId: number;
  name: string;
  average: number;
  count: number;
  comments: string[];
  last: string;
}

// Where an item comes from. A request is something a member asked for and
// stays until a member removes it. A dish item belongs to a dish and goes
// with it. A staple is the planner's own pick: a restock or an everyday
// basic.
export type ItemSource = "request" | "dish" | "staple";

export interface WeekItem {
  id: number;
  weekId: string;
  productCode: string;
  // From the product catalogue: null when the code was never seen.
  name: string | null;
  unitPrice: number | null;
  qty: number;
  reason: string;
  source: ItemSource;
  // The member who asked, for requests.
  requestedBy: string | null;
  listItemId: number | null;
  dishId: number | null;
  // The pantry entry this restocks, set back to "have" once ordered.
  restocks: string | null;
  addedBy: string;
  removedAt: string | null;
}

export interface NewItem {
  productCode: string;
  qty: number;
  reason?: string;
  source: ItemSource;
  requestedBy?: string | null;
  listItemId?: number | null;
  dishId?: number | null;
  restocks?: string | null;
}

export function dataDir(householdId: string): string {
  const base = (process.env.WILLYS_BOT_DATA ?? new URL("../../data/", import.meta.url).pathname).replace(/\/$/, "");
  const dir = `${base}/${householdId}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

export class Store {
  readonly #db: DatabaseSync;
  // The household's data directory, which holds the database.
  readonly dir: string;

  constructor(path: string) {
    this.dir = dirname(path);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS list_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        quantity TEXT,
        note TEXT,
        product_code TEXT,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        plan_id TEXT
      );
      CREATE TABLE IF NOT EXISTS products (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manufacturer TEXT,
        volume TEXT,
        compare_unit TEXT,
        -- Willys's category path, "Skafferi > Kryddor & smaksättare > Kryddor",
        -- fetched when a rule needs it.
        category TEXT,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prices (
        product_code TEXT NOT NULL,
        observed_on TEXT NOT NULL,
        kind TEXT NOT NULL,
        price REAL NOT NULL,
        compare_price TEXT,
        label TEXT,
        PRIMARY KEY (product_code, observed_on, kind)
      );
      CREATE TABLE IF NOT EXISTS weeks (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('drafting', 'open', 'approved', 'applied', 'skipped', 'failed')),
        summary TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        announced_version INTEGER NOT NULL DEFAULT 0,
        drafting_since TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        decided_by TEXT,
        decided_at TEXT,
        applied_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS recipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        servings INTEGER,
        ingredients TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT '',
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_id TEXT NOT NULL REFERENCES weeks (id),
        recipe_id INTEGER REFERENCES recipes (id),
        name TEXT NOT NULL,
        portions INTEGER NOT NULL CHECK (portions > 0),
        why TEXT NOT NULL DEFAULT '',
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        removed_by TEXT,
        removed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS week_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_id TEXT NOT NULL REFERENCES weeks (id),
        product_code TEXT NOT NULL,
        qty INTEGER NOT NULL CHECK (qty > 0),
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('request', 'dish', 'staple')),
        requested_by TEXT,
        list_item_id INTEGER REFERENCES list_items (id),
        dish_id INTEGER REFERENCES dishes (id),
        restocks TEXT,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        removed_by TEXT,
        removed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS week_items_week ON week_items (week_id);
      CREATE INDEX IF NOT EXISTS dishes_week ON dishes (week_id);
      CREATE TABLE IF NOT EXISTS pantry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        quantity TEXT,
        note TEXT,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        sender TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        channel TEXT NOT NULL,
        ts TEXT NOT NULL,
        thread_ts TEXT,
        sender TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'action')),
        text TEXT NOT NULL,
        reply TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        by TEXT NOT NULL,
        text TEXT NOT NULL,
        posted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dish_id INTEGER NOT NULL REFERENCES dishes (id),
        member TEXT NOT NULL,
        stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment TEXT,
        at TEXT NOT NULL,
        UNIQUE (dish_id, member)
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Columns added after a table was first created.
    const has = (table: string, column: string) => this.#db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has("products", "category")) this.#db.exec(`ALTER TABLE products ADD COLUMN category TEXT`);
    if (!has("dishes", "origin")) this.#db.exec(`ALTER TABLE dishes ADD COLUMN origin TEXT`);
    if (!has("dishes", "picked_by")) this.#db.exec(`ALTER TABLE dishes ADD COLUMN picked_by TEXT`);
    if (!has("recipes", "structured")) this.#db.exec(`ALTER TABLE recipes ADD COLUMN structured TEXT`);
  }

  close(): void {
    this.#db.close();
  }

  // Shopping list

  addListItem(item: { text: string; quantity?: string | null; note?: string | null; productCode?: string | null; addedBy: string }): ListItem {
    const row = this.#db
      .prepare(
        `INSERT INTO list_items (text, quantity, note, product_code, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(item.text, item.quantity ?? null, item.note ?? null, item.productCode ?? null, item.addedBy, now());
    const added = toListItem(row);
    this.logChange(item.addedBy, `added ${describe(added)} to the list`);
    return added;
  }

  listItems(statuses: ListStatus[] = ["open"]): ListItem[] {
    const marks = statuses.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT * FROM list_items WHERE status IN (${marks}) ORDER BY id`).all(...statuses).map(toListItem);
  }

  // `by` names the person making the change, for the change log; changes
  // the bot makes while ordering pass none.
  updateListItem(id: number, patch: { status?: ListStatus; productCode?: string | null; quantity?: string | null; note?: string | null; weekId?: string | null }, by?: string): ListItem | null {
    const current = this.#db.prepare(`SELECT * FROM list_items WHERE id = ?`).get(id);
    if (!current) return null;
    const c = toListItem(current);
    const row = this.#db
      .prepare(`UPDATE list_items SET status = ?, product_code = ?, quantity = ?, note = ?, plan_id = ? WHERE id = ? RETURNING *`)
      .get(
        patch.status ?? c.status,
        patch.productCode !== undefined ? patch.productCode : c.productCode,
        patch.quantity !== undefined ? patch.quantity : c.quantity,
        patch.note !== undefined ? patch.note : c.note,
        patch.weekId !== undefined ? patch.weekId : c.weekId,
        id,
      );
    const updated = toListItem(row);
    if (by) {
      if (patch.status === "removed" && c.status !== "removed") this.logChange(by, `removed ${describe(c)} from the list`);
      else if (updated.quantity !== c.quantity || updated.note !== c.note || updated.productCode !== c.productCode) this.logChange(by, `changed ${describe(updated)} on the list`);
    }
    return updated;
  }

  // Pantry: what the household keeps at home, so the planner neither buys
  // what is there nor forgets what has run out. Names are matched without
  // regard to case or surrounding space.

  pantryItems(): PantryItem[] {
    return this.#db.prepare(`SELECT * FROM pantry ORDER BY name`).all().map(toPantryItem);
  }

  setPantryItem(item: { name: string; status: PantryStatus; quantity?: string | null; note?: string | null; updatedBy: string }): PantryItem {
    const key = item.name.trim().toLowerCase();
    const current = this.#db.prepare(`SELECT * FROM pantry WHERE name_key = ?`).get(key);
    const c = current ? toPantryItem(current) : null;
    const row = this.#db
      .prepare(
        `INSERT INTO pantry (name, name_key, status, quantity, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, status = excluded.status, quantity = excluded.quantity,
           note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(
        item.name.trim(),
        key,
        item.status,
        item.quantity !== undefined ? item.quantity : (c?.quantity ?? null),
        item.note !== undefined ? item.note : (c?.note ?? null),
        item.updatedBy,
        now(),
      );
    const saved = toPantryItem(row);
    // Restocking after an order is the bot's own bookkeeping, not news.
    if (item.updatedBy !== "food-bot" && (!c || c.status !== saved.status)) this.logChange(item.updatedBy, `marked ${saved.name} as ${saved.status === "have" ? "in stock" : saved.status} in the pantry`);
    return saved;
  }

  removePantryItem(name: string, by?: string): boolean {
    const removed = this.#db.prepare(`DELETE FROM pantry WHERE name_key = ? RETURNING name`).get(name.trim().toLowerCase());
    if (removed && by) this.logChange(by, `stopped tracking ${String(removed.name)} in the pantry`);
    return !!removed;
  }

  // Change log: who changed what in the list, pantry and preferences, for
  // the weekly Slack thread. Rows are posted once and then marked.

  logChange(by: string, text: string): void {
    this.#db.prepare(`INSERT INTO changes (at, by, text) VALUES (?, ?, ?)`).run(now(), by, text);
  }

  // Takes the changes nobody has posted yet, marking them in the same
  // statement, so two processes never post the same change.
  claimChanges(): { id: number; at: string; by: string; text: string }[] {
    return this.#db
      .prepare(`UPDATE changes SET posted = 1 WHERE posted = 0 RETURNING id, at, by, text`)
      .all()
      .map((r) => ({ id: Number(r.id), at: String(r.at), by: String(r.by), text: String(r.text) }))
      .sort((a, b) => a.id - b.id);
  }

  // Hands claimed changes back when posting them failed.
  releaseChanges(ids: number[]): void {
    const stmt = this.#db.prepare(`UPDATE changes SET posted = 0 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }


  // Products and prices

  recordProduct(p: Product, kind: PriceKind, observedOn = today()): void {
    this.#db
      .prepare(
        `INSERT INTO products (code, name, manufacturer, volume, compare_unit, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, manufacturer = coalesce(excluded.manufacturer, products.manufacturer),
           volume = excluded.volume, compare_unit = excluded.compare_unit, last_seen = excluded.last_seen`,
      )
      .run(p.code, p.name, p.manufacturer ?? null, p.displayVolume ?? null, p.comparePriceUnit ?? null, observedOn);

    // The regular shelf price is always on the product; a promotion adds a
    // second observation at the promotional price.
    this.#upsertPrice(p.code, observedOn, "regular", p.priceValue, p.comparePrice ?? null, null);
    const promo = p.potentialPromotions?.[0];
    if (promo && kind !== "regular") {
      const price = promoUnitPrice(p.priceValue, promo);
      if (price !== null) {
        const label = [promo.conditionLabel, promo.rewardLabel ?? promo.cartLabel, promo.textLabelGenerated].filter(Boolean).join(" ");
        this.#upsertPrice(p.code, observedOn, kind, price, promo.comparePrice ?? null, label || null);
      }
    }
  }

  #upsertPrice(code: string, on: string, kind: PriceKind, price: number, comparePrice: string | null, label: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO prices (product_code, observed_on, kind, price, compare_price, label) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (product_code, observed_on, kind) DO UPDATE SET price = excluded.price,
           compare_price = excluded.compare_price, label = excluded.label`,
      )
      .run(code, on, kind, price, comparePrice, label);
  }

  priceHistory(code: string, sinceDays = 365): PriceObservation[] {
    return this.#db
      .prepare(
        `SELECT * FROM prices WHERE product_code = ? AND observed_on >= date('now', ?) ORDER BY observed_on, kind`,
      )
      .all(code, `-${sinceDays} days`)
      .map((r) => ({
        productCode: String(r.product_code),
        observedOn: String(r.observed_on),
        kind: r.kind as PriceKind,
        price: Number(r.price),
        comparePrice: (r.compare_price as string | null) ?? null,
        label: (r.label as string | null) ?? null,
      }));
  }

  // Promotions recorded on the latest snapshot day, optionally filtered by a
  // word in the product name or brand. Online orders only get online
  // promotions; in-store ones are kept for the price history.
  currentOffers(filter?: string, limit = 50, kinds: PriceKind[] = ["online-promo"]): Array<{ code: string; name: string; volume: string | null; kind: PriceKind; price: number; regular: number | null; label: string | null }> {
    const like = `%${(filter ?? "").toLowerCase()}%`;
    return this.#db
      .prepare(
        `SELECT p.product_code AS code, pr.name, pr.volume, p.kind, p.price, p.label,
                (SELECT r.price FROM prices r WHERE r.product_code = p.product_code AND r.observed_on = p.observed_on AND r.kind = 'regular') AS regular
         FROM prices p JOIN products pr ON pr.code = p.product_code
         WHERE p.kind IN (SELECT value FROM json_each(?))
           AND p.observed_on = (SELECT MAX(observed_on) FROM prices WHERE kind != 'regular')
           AND (lower(pr.name) LIKE ? OR lower(coalesce(pr.manufacturer, '')) LIKE ?)
         ORDER BY pr.name LIMIT ?`,
      )
      .all(JSON.stringify(kinds), like, like, limit)
      .map((r) => ({
        code: String(r.code),
        name: String(r.name),
        volume: (r.volume as string | null) ?? null,
        kind: r.kind as PriceKind,
        price: Number(r.price),
        regular: r.regular === null ? null : Number(r.regular),
        label: (r.label as string | null) ?? null,
      }));
  }

  // What an online order pays: the lowest regular or online-promotion price
  // on the most recent day the product was seen.
  latestPrice(code: string): number | null {
    const r = this.#db
      .prepare(
        `SELECT MIN(price) AS price FROM prices WHERE product_code = ? AND kind IN ('regular', 'online-promo')
         AND observed_on = (SELECT MAX(observed_on) FROM prices WHERE product_code = ? AND kind IN ('regular', 'online-promo'))`,
      )
      .get(code, code);
    return r && r.price !== null ? Number(r.price) : null;
  }

  // The product's category path, or null when not fetched yet.
  productCategory(code: string): string | null {
    const r = this.#db.prepare(`SELECT category FROM products WHERE code = ?`).get(code);
    return r ? ((r.category as string | null) ?? null) : null;
  }

  setProductDetails(code: string, details: { brand: string | null; category: string }): void {
    this.#db.prepare(`UPDATE products SET manufacturer = coalesce(?, manufacturer), category = ? WHERE code = ?`).run(details.brand, details.category, code);
  }

  productBrand(code: string): string | null {
    const r = this.#db.prepare(`SELECT manufacturer FROM products WHERE code = ?`).get(code);
    return r ? ((r.manufacturer as string | null) ?? null) : null;
  }

  productName(code: string): string | null {
    const r = this.#db.prepare(`SELECT name, volume FROM products WHERE code = ?`).get(code);
    if (!r) return null;
    const name = String(r.name);
    const volume = r.volume ? String(r.volume) : "";
    return volume && !name.toLowerCase().includes(volume.toLowerCase()) ? `${name} ${volume}` : name;
  }

  // Runs `f` in one write transaction, so other processes see all of it
  // or none of it.
  // A transaction inside another one joins it.
  transaction<T>(f: () => T): T {
    if (this.#db.isTransaction) return f();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = f();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // Weeks

  // Starts drafting the week for a pickup date. False when the week
  // already exists, so only one process ever drafts a week.
  claimWeek(id: string): boolean {
    const at = now();
    return (
      this.#db
        .prepare(`INSERT INTO weeks (id, token, status, drafting_since, created_at) VALUES (?, ?, 'drafting', ?, ?) ON CONFLICT (id) DO NOTHING`)
        .run(id, randomBytes(4).toString("hex"), at, at).changes > 0
    );
  }

  // True when a week has been drafting for longer than any draft takes,
  // which means the process drafting it died.
  draftAbandoned(id: string, maxMinutes = 45): boolean {
    const w = this.#db.prepare(`SELECT status, drafting_since FROM weeks WHERE id = ?`).get(id);
    if (!w || w.status !== "drafting" || !w.drafting_since) return false;
    return Date.now() - new Date(String(w.drafting_since)).getTime() > maxMinutes * 60_000;
  }

  // Drops a week whose draft failed, with anything written for it.
  dropWeek(id: string): void {
    this.transaction(() => {
      this.#db.prepare(`DELETE FROM week_items WHERE week_id = ?`).run(id);
      this.#db.prepare(`DELETE FROM dishes WHERE week_id = ?`).run(id);
      this.#db.prepare(`DELETE FROM weeks WHERE id = ?`).run(id);
    });
  }

  week(id: string): Week | null {
    const r = this.#db.prepare(`SELECT * FROM weeks WHERE id = ?`).get(id);
    return r ? toWeek(r) : null;
  }

  weekByToken(token: string): Week | null {
    const r = this.#db.prepare(`SELECT * FROM weeks WHERE token = ?`).get(token);
    return r ? toWeek(r) : null;
  }

  // The week waiting for a decision, if any: the latest one still open.
  openWeek(): Week | null {
    const r = this.#db.prepare(`SELECT * FROM weeks WHERE status = 'open' ORDER BY id DESC LIMIT 1`).get();
    return r ? toWeek(r) : null;
  }

  // The week changes are about: the nearest one whose pickup has not passed
  // that is waiting for a decision or approved (its cart can still change
  // until pickup).
  currentWeek(today: string): Week | null {
    const r = this.#db.prepare(`SELECT * FROM weeks WHERE status IN ('open', 'applied') AND id >= ? ORDER BY id LIMIT 1`).get(today);
    return r ? toWeek(r) : null;
  }

  weeks(limit = 20): Week[] {
    return this.#db.prepare(`SELECT * FROM weeks ORDER BY id DESC LIMIT ?`).all(limit).map(toWeek);
  }

  // Moves a week from one status to another, only if it is still in the
  // first: true when this call made the move.
  switchWeek(id: string, from: WeekStatus, to: WeekStatus): boolean {
    return (
      this.#db
        .prepare(`UPDATE weeks SET status = ?, drafting_since = CASE WHEN ? = 'drafting' THEN ? ELSE NULL END WHERE id = ? AND status = ?`)
        .run(to, to, now(), id, from).changes > 0
    );
  }

  // Marks the household as shown a version, unless a later one was shown.
  markAnnounced(id: string, version: number): void {
    this.#db.prepare(`UPDATE weeks SET announced_version = ? WHERE id = ? AND announced_version < ?`).run(version, id, version);
  }

  // Open weeks whose pickup day has passed without a decision.
  staleWeeks(today: string): Week[] {
    return this.#db.prepare(`SELECT * FROM weeks WHERE status = 'open' AND id < ?`).all(today).map(toWeek);
  }

  // List items a week took on, sent back to the list (when the week is
  // skipped or fails) or marked ordered (when its cart is filled).
  releaseListItems(weekId: string): void {
    this.#db.prepare(`UPDATE list_items SET status = 'open', plan_id = NULL WHERE status = 'planned' AND plan_id = ?`).run(weekId);
  }

  // Marks ordered every list item the week took on, whether it is still
  // planned for the week or was sent back to the list in the meantime.
  orderListItems(weekId: string): void {
    this.#db
      .prepare(
        `UPDATE list_items SET status = 'ordered', plan_id = ?
         WHERE (status = 'planned' AND plan_id = ?)
            OR (status = 'open' AND id IN (SELECT list_item_id FROM week_items WHERE week_id = ? AND removed_at IS NULL AND list_item_id IS NOT NULL))`,
      )
      .run(weekId, weekId, weekId);
  }

  updateWeek(id: string, patch: Partial<Pick<Week, "status" | "summary" | "notes" | "announcedVersion" | "sentAt" | "decidedBy" | "decidedAt" | "appliedAt" | "error">>): Week {
    const cols: Record<string, string> = {
      status: "status", summary: "summary", notes: "notes", announcedVersion: "announced_version", sentAt: "sent_at",
      decidedBy: "decided_by", decidedAt: "decided_at", appliedAt: "applied_at", error: "error",
    };
    for (const [k, v] of Object.entries(patch)) this.#db.prepare(`UPDATE weeks SET ${cols[k]} = ? WHERE id = ?`).run(v as string | number | null, id);
    return this.week(id)!;
  }

  // Dishes

  dishes(weekId: string): Dish[] {
    return this.#db.prepare(`SELECT * FROM dishes WHERE week_id = ? AND removed_at IS NULL ORDER BY id`).all(weekId).map(toDish);
  }

  dish(id: number): Dish | null {
    const r = this.#db.prepare(`SELECT * FROM dishes WHERE id = ?`).get(id);
    return r ? toDish(r) : null;
  }

  addDish(weekId: string, dish: { name: string; portions: number; why?: string; recipeId?: number | null; origin?: string | null }, by: string): Dish {
    return this.transaction(() => {
      const row = this.#db
        .prepare(`INSERT INTO dishes (week_id, recipe_id, name, portions, why, origin, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(weekId, dish.recipeId ?? null, dish.name, dish.portions, dish.why ?? "", dish.origin || null, by, now());
      this.changed(weekId, by, `added the dish ${dish.name}`);
      return toDish(row);
    });
  }

  // Removes a dish and the items bought for it. Requests stay, even when
  // they were linked to the dish.
  removeDish(id: number, by: string): Dish | null {
    const d = this.dish(id);
    if (!d || d.removedAt) return null;
    const at = now();
    this.transaction(() => {
      this.#db.prepare(`UPDATE dishes SET removed_by = ?, removed_at = ? WHERE id = ?`).run(by, at, id);
      this.#db.prepare(`UPDATE week_items SET removed_by = ?, removed_at = ? WHERE dish_id = ? AND source = 'dish' AND removed_at IS NULL`).run(by, at, id);
      this.#db.prepare(`UPDATE week_items SET dish_id = NULL WHERE dish_id = ? AND source <> 'dish'`).run(id);
      this.changed(d.weekId, by, `removed the dish ${d.name} and its ingredients`);
    });
    return d;
  }

  // Marks a dish as picked to cook this week, or not. False when nothing
  // changed.
  pickDish(id: number, picked: boolean, by: string): boolean {
    return this.transaction(() => {
      const d = this.dish(id);
      if (!d || d.removedAt || (d.pickedBy !== null) === picked) return false;
      this.#db.prepare(`UPDATE dishes SET picked_by = ? WHERE id = ?`).run(picked ? by : null, id);
      this.changed(d.weekId, by, `${picked ? "picked" : "unpicked"} the dish ${d.name}`);
      return true;
    });
  }

  // Ratings

  // Records a member's rating of a dish, replacing their earlier one.
  rateDish(dishId: number, member: string, stars: number, comment?: string | null): Rating {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error("A rating is a whole number from 1 to 5");
    if (!this.dish(dishId)) throw new Error(`No dish ${dishId}`);
    this.#db
      .prepare(
        `INSERT INTO ratings (dish_id, member, stars, comment, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (dish_id, member) DO UPDATE SET stars = excluded.stars, comment = COALESCE(excluded.comment, ratings.comment), at = excluded.at`,
      )
      .run(dishId, member, stars, comment?.trim() || null, now());
    return this.dishRatings(dishId).find((r) => r.member === member)!;
  }

  dishRatings(dishId: number): Rating[] {
    return this.#db
      .prepare(`SELECT r.*, d.recipe_id, d.week_id, d.name AS dish_name FROM ratings r JOIN dishes d ON d.id = r.dish_id WHERE r.dish_id = ? ORDER BY r.at`)
      .all(dishId)
      .map(toRating);
  }

  // Every recipe the household has rated, best first.
  recipeRatings(): RecipeRating[] {
    const rows = this.#db
      .prepare(
        `SELECT r.*, d.recipe_id, d.week_id, d.name AS dish_name FROM ratings r JOIN dishes d ON d.id = r.dish_id
         WHERE d.recipe_id IS NOT NULL ORDER BY r.at DESC, r.id DESC`,
      )
      .all()
      .map(toRating);
    const by = new Map<number, Rating[]>();
    for (const r of rows) by.set(r.recipeId!, [...(by.get(r.recipeId!) ?? []), r]);
    return [...by]
      .map(([recipeId, list]) => ({
        recipeId,
        name: list[0]!.dishName,
        average: Math.round((list.reduce((a, r) => a + r.stars, 0) / list.length) * 10) / 10,
        count: list.length,
        comments: list.map((r) => r.comment).filter((c): c is string => !!c).slice(0, 4),
        last: list[0]!.at,
      }))
      .sort((a, b) => b.average - a.average || b.count - a.count);
  }

  // Items

  // Every item the week ever had, removed ones too.
  allItems(weekId: string): WeekItem[] {
    return this.#db.prepare(`SELECT * FROM week_items WHERE week_id = ? ORDER BY id`).all(weekId).map((r) => this.#toItem(r));
  }

  items(weekId: string): WeekItem[] {
    return this.#db.prepare(`SELECT * FROM week_items WHERE week_id = ? AND removed_at IS NULL ORDER BY id`).all(weekId).map((r) => this.#toItem(r));
  }

  item(id: number): WeekItem | null {
    const r = this.#db.prepare(`SELECT * FROM week_items WHERE id = ?`).get(id);
    return r ? this.#toItem(r) : null;
  }

  addItem(weekId: string, item: NewItem, by: string): WeekItem {
    return this.transaction(() => {
      const row = this.#db
        .prepare(
          `INSERT INTO week_items (week_id, product_code, qty, reason, source, requested_by, list_item_id, dish_id, restocks, added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(weekId, item.productCode, item.qty, item.reason ?? "", item.source, item.requestedBy ?? null, item.listItemId ?? null, item.dishId ?? null, item.restocks ?? null, by, now());
      const added = this.#toItem(row);
      this.changed(weekId, by, `added ${added.qty} x ${added.name ?? added.productCode} to this week's shop`);
      return added;
    });
  }

  setItemQuantity(id: number, qty: number, by: string): WeekItem | null {
    return this.transaction(() => {
      const before = this.item(id);
      if (!before || before.removedAt) return null;
      const row = this.#db.prepare(`UPDATE week_items SET qty = ? WHERE id = ? RETURNING *`).get(qty, id);
      this.changed(before.weekId, by, `changed ${before.name ?? before.productCode} from ${before.qty} to ${qty}`);
      return this.#toItem(row);
    });
  }

  // Removes an item. A removed request takes its list item off the list
  // too: the member no longer wants it.
  removeItem(id: number, by: string): WeekItem | null {
    return this.transaction(() => {
      const before = this.item(id);
      if (!before || before.removedAt) return null;
      this.#db.prepare(`UPDATE week_items SET removed_by = ?, removed_at = ? WHERE id = ?`).run(by, now(), id);
      if (before.source === "request" && before.listItemId !== null) {
        this.#db.prepare(`UPDATE list_items SET status = 'removed' WHERE id = ? AND status = 'planned'`).run(before.listItemId);
      }
      this.changed(before.weekId, by, `removed ${before.qty} x ${before.name ?? before.productCode} from this week's shop`);
      return before;
    });
  }

  // Recipes: every dish the household has been offered, for cooking and
  // for reuse in later weeks. A saved recipe never changes, so past weeks
  // keep the recipe they had; a new version is a new recipe.

  saveRecipe(r: { name: string; servings?: number | null; ingredients: string; method: string; notes?: string | null; structured?: StructuredRecipe | null }, by: string): Recipe {
    const row = this.#db
      .prepare(
        `INSERT INTO recipes (name, servings, ingredients, method, notes, structured, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(r.name.trim(), r.servings ?? null, r.ingredients, r.method, r.notes ?? null, r.structured ? JSON.stringify(r.structured) : null, by, now(), now());
    return toRecipe(row);
  }

  recipe(id: number): Recipe | null {
    const r = this.#db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(id);
    return r ? toRecipe(r) : null;
  }

  recipes(filter?: string): Recipe[] {
    return this.#db
      .prepare(`SELECT * FROM recipes WHERE ? IS NULL OR name LIKE ? ORDER BY updated_at DESC`)
      .all(filter ?? null, `%${filter ?? ""}%`)
      .map(toRecipe);
  }

  // Dishes from weeks before `weekId`, newest first, so the planner can vary
  // the menu and reuse what went down well.
  pastDishes(weekId: string, limit = 30): { weekId: string; name: string; recipeId: number | null; status: WeekStatus }[] {
    return this.#db
      .prepare(
        `SELECT d.week_id, d.name, d.recipe_id, w.status FROM dishes d JOIN weeks w ON w.id = d.week_id
         WHERE d.week_id < ? AND d.removed_at IS NULL ORDER BY d.week_id DESC, d.id LIMIT ?`,
      )
      .all(weekId, limit)
      .map((r) => ({ weekId: String(r.week_id), name: String(r.name), recipeId: r.recipe_id === null ? null : Number(r.recipe_id), status: r.status as WeekStatus }));
  }

  // Every change to an open week bumps its version and goes in the change
  // log, in the same transaction as the change. Writes while the planner
  // drafts a week are neither; a redraft reports itself once afterwards.
  changed(weekId: string, by: string, text: string): void {
    this.transaction(() => {
      const w = this.week(weekId);
      if (!w || w.status === "drafting") return;
      this.#db.prepare(`UPDATE weeks SET version = version + 1 WHERE id = ?`).run(weekId);
      this.logChange(by, text);
    });
  }

  #toItem(r: Record<string, unknown> | undefined): WeekItem {
    if (!r) throw new Error("missing row");
    const code = String(r.product_code);
    return {
      id: Number(r.id),
      weekId: String(r.week_id),
      productCode: code,
      name: this.productName(code),
      unitPrice: this.latestPrice(code),
      qty: Number(r.qty),
      reason: String(r.reason),
      source: r.source as ItemSource,
      requestedBy: (r.requested_by as string | null) ?? null,
      listItemId: r.list_item_id === null ? null : Number(r.list_item_id),
      dishId: r.dish_id === null ? null : Number(r.dish_id),
      restocks: (r.restocks as string | null) ?? null,
      addedBy: String(r.added_by),
      removedAt: (r.removed_at as string | null) ?? null,
    };
  }

  // Received email: one row per email to the bot that was looked at, so
  // nothing is acted on twice. "retry" rows are tried again on the next run.

  mailRecord(id: string): MailRecord | null {
    const r = this.#db.prepare(`SELECT * FROM mail WHERE id = ?`).get(id);
    return r ? toMail(r) : null;
  }

  recordMail(m: Omit<MailRecord, "updatedAt">): void {
    this.#db
      .prepare(
        `INSERT INTO mail (id, received_at, sender, subject, status, attempts, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(m.id, m.receivedAt, m.sender, m.subject, m.status, m.attempts, m.note, now());
  }

  // Slack messages and button clicks food-bot handled, with its answer, so
  // what members asked for is on record here and not only in Slack.

  recordSlack(m: Omit<SlackMessage, "id" | "at">): SlackMessage {
    const row = this.#db
      .prepare(`INSERT INTO slack_messages (at, channel, ts, thread_ts, sender, name, kind, text, reply, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(now(), m.channel, m.ts, m.threadTs, m.sender, m.name, m.kind, m.text, m.reply, m.error);
    return toSlackMessage(row);
  }

  slackMessages(limit = 50): SlackMessage[] {
    return this.#db.prepare(`SELECT * FROM slack_messages ORDER BY id DESC LIMIT ?`).all(limit).map(toSlackMessage);
  }

  // Small key/value state: the saved Willys session, the inbox start date.

  get(key: string): string | null {
    const r = this.#db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
    return r ? String(r.value) : null;
  }

  // Sets a key only if it is unset; true when this call set it. Used to
  // make sure only one process starts something, such as a week's thread.
  claim(key: string, value: string): boolean {
    return this.#db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`).run(key, value).changes > 0;
  }

  delete(key: string): void {
    this.#db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
  }

  set(key: string, value: string): void {
    this.#db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}

// The effective per-unit price of a promotion, or null when it cannot be
// read off the labels (for example a percentage off a mix of products).
export function promoUnitPrice(regular: number, promo: NonNullable<Product["potentialPromotions"]>[number]): number | null {
  if (typeof promo.price === "number" && promo.price > 0) return promo.price;
  const reward = parseSek(promo.rewardLabel ?? promo.cartLabel ?? "");
  if (reward === null) return null;
  const count = promo.qualifyingCount ?? 1;
  // "3 för 10,00" is a total for the bundle, "Spara 15,00 kr/st 9,90/st" ends in a unit price.
  if (count > 1 && /för/i.test(promo.conditionLabel ?? "")) return round(reward / count);
  if (reward > regular * 1.5) return null;
  return reward;
}

function parseSek(label: string): number | null {
  const matches = [...label.matchAll(/(\d+(?:[.,]\d+)?)/g)];
  if (!matches.length) return null;
  const n = Number(matches[matches.length - 1][1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const round = (n: number) => Math.round(n * 100) / 100;

// "2 x milk (lactose free)" for the change log.
function describe(i: ListItem): string {
  return `${i.quantity ? `${i.quantity} x ` : ""}${i.text}${i.note ? ` (${i.note})` : ""}`;
}

function toListItem(r: Record<string, unknown> | undefined): ListItem {
  if (!r) throw new Error("missing row");
  return {
    id: Number(r.id),
    text: String(r.text),
    quantity: (r.quantity as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    productCode: (r.product_code as string | null) ?? null,
    addedBy: String(r.added_by),
    addedAt: String(r.added_at),
    status: r.status as ListStatus,
    weekId: (r.plan_id as string | null) ?? null,
  };
}

function toPantryItem(r: Record<string, unknown> | undefined): PantryItem {
  if (!r) throw new Error("missing row");
  return {
    id: Number(r.id),
    name: String(r.name),
    status: r.status as PantryStatus,
    quantity: (r.quantity as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    updatedBy: String(r.updated_by),
    updatedAt: String(r.updated_at),
  };
}

function toMail(r: Record<string, unknown>): MailRecord {
  return {
    id: String(r.id),
    receivedAt: String(r.received_at),
    sender: String(r.sender),
    subject: String(r.subject),
    status: r.status as MailStatus,
    attempts: Number(r.attempts),
    note: (r.note as string | null) ?? null,
    updatedAt: String(r.updated_at),
  };
}

function toSlackMessage(r: Record<string, unknown> | undefined): SlackMessage {
  if (!r) throw new Error("missing row");
  return {
    id: Number(r.id),
    at: String(r.at),
    channel: String(r.channel),
    ts: String(r.ts),
    threadTs: (r.thread_ts as string | null) ?? null,
    sender: String(r.sender),
    name: String(r.name),
    kind: r.kind as SlackMessage["kind"],
    text: String(r.text),
    reply: (r.reply as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function toWeek(r: Record<string, unknown>): Week {
  return {
    id: String(r.id),
    token: String(r.token),
    status: r.status as WeekStatus,
    summary: String(r.summary),
    notes: String(r.notes),
    version: Number(r.version),
    announcedVersion: Number(r.announced_version),
    createdAt: String(r.created_at),
    sentAt: (r.sent_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    appliedAt: (r.applied_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function toDish(r: Record<string, unknown> | undefined): Dish {
  if (!r) throw new Error("missing row");
  return {
    id: Number(r.id),
    weekId: String(r.week_id),
    recipeId: r.recipe_id === null ? null : Number(r.recipe_id),
    name: String(r.name),
    portions: Number(r.portions),
    why: String(r.why),
    origin: (r.origin as string | null) ?? null,
    pickedBy: (r.picked_by as string | null) ?? null,
    addedBy: String(r.added_by),
    removedAt: (r.removed_at as string | null) ?? null,
  };
}

function toRating(r: Record<string, unknown>): Rating {
  return {
    dishId: Number(r.dish_id),
    recipeId: r.recipe_id === null ? null : Number(r.recipe_id),
    weekId: String(r.week_id),
    dishName: String(r.dish_name),
    member: String(r.member),
    stars: Number(r.stars),
    comment: (r.comment as string | null) ?? null,
    at: String(r.at),
  };
}

function toRecipe(r: Record<string, unknown> | undefined): Recipe {
  if (!r) throw new Error("missing row");
  return {
    id: Number(r.id),
    name: String(r.name),
    servings: r.servings === null ? null : Number(r.servings),
    ingredients: String(r.ingredients),
    method: String(r.method),
    notes: (r.notes as string | null) ?? null,
    structured: typeof r.structured === "string" ? (JSON.parse(r.structured) as StructuredRecipe) : null,
    createdBy: String(r.created_by),
    updatedAt: String(r.updated_at),
  };
}
