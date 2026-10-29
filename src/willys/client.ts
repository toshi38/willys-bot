import { encryptCredential } from "./crypto.ts";
import type { CampaignKind, Cart, Customer, PickupSlot, PickupSlots, ProductPage, Promotion, Store } from "./types.ts";

// Client for the JSON API behind willys.se. It keeps a cookie jar so a
// logged-in session can be saved and reused instead of logging in on every
// run, and spaces requests out so a whole weekly run looks like one person
// shopping. Login and cart calls follow ErikHellman/willys-agent (MIT); slot
// endpoints are the ones willys.se's own checkout calls.

const BASE_URL = "https://www.willys.se";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const MIN_INTERVAL_MS = 1000;

export interface Credentials {
  username: string;
  password: string;
}

export class WillysError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class WillysClient {
  readonly #cookies = new Map<string, string>();
  #csrf: string | null = null;
  #lastRequest = 0;

  constructor(cookies: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(cookies)) this.#cookies.set(k, v);
  }

  cookies(): Record<string, string> {
    return Object.fromEntries(this.#cookies);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const wait = this.#lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#lastRequest = Date.now();

    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", USER_AGENT);
    if (this.#cookies.size) headers.set("Cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = init.method ?? "GET";
    if (method !== "GET") {
      headers.set("X-CSRF-TOKEN", this.#csrf ?? (await this.csrfToken()));
      if (init.body) headers.set("Content-Type", "application/json");
    }

    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const res = await fetch(url, { ...init, method, headers, redirect: "manual" });
    for (const header of res.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (!res.ok) throw new WillysError(`${init.method ?? "GET"} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async csrfToken(): Promise<string> {
    if (!this.#cookies.has("JSESSIONID")) await this.request("/api/config");
    this.#csrf = await this.json<string>("/axfood/rest/csrf-token");
    return this.#csrf;
  }

  async login(creds: Credentials): Promise<Customer> {
    await this.csrfToken();
    const user = encryptCredential(creds.username);
    const pass = encryptCredential(creds.password);
    const res = await this.request("/login", {
      method: "POST",
      body: JSON.stringify({
        j_username: user.str,
        j_username_key: user.key,
        j_password: pass.str,
        j_password_key: pass.key,
        j_remember_me: true,
      }),
    });
    if (res.status >= 400) throw new WillysError(`Login failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    const location = res.headers.get("location");
    if (location) await this.request(location);
    await this.csrfToken();
    const customer = await this.customer();
    if (!customer) throw new WillysError("Login returned no customer: check the username and password", 401);
    return customer;
  }

  // The logged-in customer, or null for an anonymous session.
  async customer(): Promise<Customer | null> {
    const c = await this.json<Customer | undefined>("/axfood/rest/customer");
    return c && c.uid && c.uid !== "anonymous" ? c : null;
  }

  search(query: string, page = 0, size = 20): Promise<ProductPage> {
    const q = new URLSearchParams({ q: query, page: String(page), size: String(size) });
    return this.json(`/search/clean?${q}`);
  }

  // Current promotions for a store: "online" are the ones that apply to
  // online orders, "offline" the in-store flyer.
  // In-store offers come without a product code or numeric price on the
  // product itself; both are filled in from the promotion and price label.
  async campaigns(kind: CampaignKind, storeId: string, page = 0, size = 100): Promise<ProductPage> {
    const type = kind === "online" ? "PERSONAL_GENERAL" : "PERSONAL_ALL";
    const q = new URLSearchParams({ q: storeId, type, page: String(page), size: String(size) });
    const res = await this.json<ProductPage>(`/search/campaigns/${kind}?${q}`);
    const results = res.results.flatMap((p) => {
      const promo = p.potentialPromotions?.[0] as (Promotion & { mainProductCode?: string }) | undefined;
      const code = p.code ?? promo?.mainProductCode;
      const priceValue = p.priceValue ?? parseSek(p.priceNoUnit ?? p.price);
      return code && priceValue !== null ? [{ ...p, code, priceValue }] : [];
    });
    return { ...res, results };
  }

  stores(): Promise<Store[]> {
    return this.json("/axfood/rest/store?online=true&clickAndCollect=true&b2bClickAndCollect=false");
  }

  cart(): Promise<Cart> {
    return this.json("/axfood/rest/cart");
  }

  // Sets each product's quantity in the cart; quantity 0 removes it.
  async setCartQuantities(lines: Array<{ code: string; qty: number }>): Promise<Cart> {
    await this.json("/axfood/rest/cart/addProducts", {
      method: "POST",
      body: JSON.stringify({
        products: lines.map((l) => ({
          productCodePost: l.code,
          qty: l.qty,
          pickUnit: "pieces",
          hideDiscountToolTip: false,
          noReplacementFlag: false,
        })),
      }),
    });
    return this.cart();
  }

  // Click-and-collect slots at a store for the coming days, as willys.se's
  // checkout lists them.
  pickupSlots(storeId: string): Promise<PickupSlots> {
    return this.json(`/axfood/rest/v2/slot/pickInStore?storeId=${encodeURIComponent(storeId)}&b2b=false`);
  }

  // Puts a slot on the cart, as choosing it at checkout does.
  selectPickupSlot(slotCode: string): Promise<unknown> {
    return this.json(`/axfood/rest/v2/slot/slotInCart/${encodeURIComponent(slotCode)}?isTmsSlot=false`, { method: "POST", body: "{}" });
  }

  // The slot on the cart, if any.
  slotInCart(): Promise<PickupSlot | null> {
    return this.json<PickupSlot | null>("/axfood/rest/v2/slot/slotInCart");
  }

  orders(): Promise<unknown> {
    return this.json("/axfood/rest/account/orders");
  }

  orderDetails(orderNumber: string): Promise<unknown> {
    return this.json(`/axfood/rest/orderdata?q=${encodeURIComponent(orderNumber)}`);
  }
}

function parseSek(label: string | undefined): number | null {
  const m = label?.match(/\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
}
