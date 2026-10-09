import type { Store } from "./store.ts";
import type { WillysClient } from "../willys/client.ts";
import type { CampaignKind, Product } from "../willys/types.ts";

// Sale-price tracking. A daily snapshot records every promoted product in
// the household's store; searches record regular prices as a side effect.
// Over time this gives each product a price history to judge offers against,
// instead of trusting the "Spara X kr" on the label.

export async function snapshotCampaigns(client: WillysClient, store: Store, storeId: string): Promise<Record<CampaignKind, number>> {
  const counts: Record<CampaignKind, number> = { online: 0, offline: 0 };
  for (const kind of ["online", "offline"] as const) {
    for (let page = 0; page < 20; page++) {
      const res = await client.campaigns(kind, storeId, page, 100);
      for (const p of res.results) store.recordProduct(p, kind === "online" ? "online-promo" : "offline-promo");
      counts[kind] += res.results.length;
      if (page + 1 >= res.pagination.numberOfPages) break;
    }
  }
  return counts;
}

export function recordSearchResults(store: Store, products: Product[]): void {
  for (const p of products) store.recordProduct(p, p.potentialPromotions?.length ? "online-promo" : "regular");
}

export interface PriceVerdict {
  code: string;
  current: number;
  currentLabel: string | null;
  regular: number;
  // Lowest price seen, any kind, over the history window.
  lowest: number | null;
  // Median of all daily observed prices (the price you would usually pay).
  typical: number | null;
  observations: number;
  verdict: "great" | "good" | "normal" | "poor" | "unknown";
  summary: string;
}

// Judges a product's price today against what this household has seen.
// "great": at or within 3% of the lowest seen and at least 15% under typical.
// "good": at least 10% under typical. "poor": above typical by 5% or more.
export function judgePrice(store: Store, product: Product): PriceVerdict {
  const history = store.priceHistory(product.code, 365);
  const promo = history.filter((h) => h.kind !== "regular").at(-1);
  const today = new Date().toISOString().slice(0, 10);
  const promoToday = promo && promo.observedOn === today ? promo : null;
  const current = promoToday?.price ?? product.priceValue;

  // One effective price per day: the lowest of what was on offer that day.
  const byDay = new Map<string, number>();
  for (const h of history) byDay.set(h.observedOn, Math.min(byDay.get(h.observedOn) ?? Infinity, h.price));
  const prices = [...byDay.values()].sort((a, b) => a - b);
  const lowest = prices.length ? prices[0] : null;
  const typical = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  let verdict: PriceVerdict["verdict"] = "unknown";
  if (typical !== null && prices.length >= 3) {
    if (lowest !== null && current <= lowest * 1.03 && current <= typical * 0.85) verdict = "great";
    else if (current <= typical * 0.9) verdict = "good";
    else if (current >= typical * 1.05) verdict = "poor";
    else verdict = "normal";
  } else if (promoToday) {
    verdict = current < product.priceValue * 0.9 ? "good" : "normal";
  }

  const parts = [`${fmt(current)} kr${promoToday?.label ? ` (${promoToday.label})` : ""}`];
  if (typical !== null) parts.push(`usually ${fmt(typical)}`);
  if (lowest !== null) parts.push(`lowest seen ${fmt(lowest)}`);
  parts.push(`${byDay.size} day${byDay.size === 1 ? "" : "s"} of history`);
  return {
    code: product.code,
    current,
    currentLabel: promoToday?.label ?? null,
    regular: product.priceValue,
    lowest,
    typical,
    observations: byDay.size,
    verdict,
    summary: `${verdict}: ${parts.join(", ")}`,
  };
}

const fmt = (n: number) => n.toFixed(2).replace(/\.00$/, "");
