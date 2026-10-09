import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Product } from "../willys/types.ts";

// SQLite persistence, one database per household: the shared shopping list,
// every price seen (regular and promotional) for sale-price judgement, the
// weekly plans with their approval state, and the saved Willys session.

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
  planId: string | null;
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

export type PlanStatus = "draft" | "sent" | "approved" | "rejected" | "applied" | "failed";

export interface PlanLine {
  productCode: string;
  name: string;
  qty: number;
  unitPrice: number;
  reason: string;
  listItemIds: number[];
}

export interface PlanRow {
  id: string;
  createdAt: string;
  status: PlanStatus;
  // Short token in the email subject that ties a reply to this plan.
  token: string;
  plan: unknown;
  lines: PlanLine[];
  sentAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  error: string | null;
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
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        lines TEXT NOT NULL,
        sent_at TEXT,
        decided_by TEXT,
        decided_at TEXT,
        decision_note TEXT,
        applied_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
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
    return toListItem(row);
  }

  listItems(statuses: ListStatus[] = ["open"]): ListItem[] {
    const marks = statuses.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT * FROM list_items WHERE status IN (${marks}) ORDER BY id`).all(...statuses).map(toListItem);
  }

  updateListItem(id: number, patch: { status?: ListStatus; productCode?: string | null; quantity?: string | null; note?: string | null; planId?: string | null }): ListItem | null {
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
        patch.planId !== undefined ? patch.planId : c.planId,
        id,
      );
    return toListItem(row);
  }

  // Products and prices

  recordProduct(p: Product, kind: PriceKind, observedOn = today()): void {
    this.#db
      .prepare(
        `INSERT INTO products (code, name, manufacturer, volume, compare_unit, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, manufacturer = excluded.manufacturer,
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

  productName(code: string): string | null {
    const r = this.#db.prepare(`SELECT name, volume FROM products WHERE code = ?`).get(code);
    if (!r) return null;
    const name = String(r.name);
    const volume = r.volume ? String(r.volume) : "";
    return volume && !name.toLowerCase().includes(volume.toLowerCase()) ? `${name} ${volume}` : name;
  }

  // Plans

  createPlan(plan: unknown, lines: PlanLine[]): PlanRow {
    const id = `${today()}-${randomBytes(3).toString("hex")}`;
    const token = randomBytes(4).toString("hex");
    this.#db
      .prepare(`INSERT INTO plans (id, created_at, status, token, plan, lines) VALUES (?, ?, 'draft', ?, ?, ?)`)
      .run(id, now(), token, JSON.stringify(plan), JSON.stringify(lines));
    return this.plan(id)!;
  }

  plan(id: string): PlanRow | null {
    const r = this.#db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id);
    return r ? toPlan(r) : null;
  }

  planByToken(token: string): PlanRow | null {
    const r = this.#db.prepare(`SELECT * FROM plans WHERE token = ?`).get(token);
    return r ? toPlan(r) : null;
  }

  plans(statuses: PlanStatus[]): PlanRow[] {
    const marks = statuses.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT * FROM plans WHERE status IN (${marks}) ORDER BY created_at DESC`).all(...statuses).map(toPlan);
  }

  updatePlan(id: string, patch: Partial<Pick<PlanRow, "status" | "sentAt" | "decidedBy" | "decidedAt" | "decisionNote" | "appliedAt" | "error" | "lines">>): void {
    const cols: Record<string, string> = {
      status: "status", sentAt: "sent_at", decidedBy: "decided_by", decidedAt: "decided_at",
      decisionNote: "decision_note", appliedAt: "applied_at", error: "error", lines: "lines",
    };
    for (const [k, v] of Object.entries(patch)) {
      const value = k === "lines" ? JSON.stringify(v) : (v as string | null);
      this.#db.prepare(`UPDATE plans SET ${cols[k]} = ? WHERE id = ?`).run(value, id);
    }
  }

  // Small key/value state: the saved Willys session, the IMAP cursor.

  get(key: string): string | null {
    const r = this.#db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
    return r ? String(r.value) : null;
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
    planId: (r.plan_id as string | null) ?? null,
  };
}

function toPlan(r: Record<string, unknown>): PlanRow {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    status: r.status as PlanStatus,
    token: String(r.token),
    plan: JSON.parse(String(r.plan)),
    lines: JSON.parse(String(r.lines)) as PlanLine[],
    sentAt: (r.sent_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    appliedAt: (r.applied_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}
