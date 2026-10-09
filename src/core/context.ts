import { join } from "node:path";
import { loadHousehold, type Household } from "./household.ts";
import { readSecret } from "./secrets.ts";
import { dataDir, Store } from "./store.ts";
import { WillysClient } from "../willys/client.ts";
import type { Customer } from "../willys/types.ts";

// Everything a command needs for one household: its config, its database and
// a Willys client. The Willys session is saved in the database and reused;
// login only happens when the saved session has expired.

export interface Context {
  household: Household;
  store: Store;
  willys: WillysClient;
  // Logs in if needed and returns the customer. Call before any cart, slot
  // or order request.
  ensureLogin(): Promise<Customer>;
  saveSession(): void;
  close(): void;
}

const SESSION_KEY = "willys.cookies";

export function openContext(householdId: string): Context {
  const household = loadHousehold(householdId);
  const store = new Store(join(dataDir(household.id), "willys-bot.sqlite"));
  const saved = store.get(SESSION_KEY);
  const willys = new WillysClient(saved ? (JSON.parse(saved) as Record<string, string>) : {});
  const saveSession = () => store.set(SESSION_KEY, JSON.stringify(willys.cookies()));

  let customer: Customer | null = null;
  return {
    household,
    store,
    willys,
    saveSession,
    async ensureLogin() {
      if (customer) return customer;
      customer = await willys.customer();
      if (!customer) {
        const secret = household.config.willys.secret;
        customer = await willys.login({ username: readSecret(secret, "username"), password: readSecret(secret, "password") });
      }
      saveSession();
      return customer;
    },
    close() {
      saveSession();
      store.close();
    },
  };
}
