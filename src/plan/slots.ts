import type { Household } from "../core/household.ts";
import type { WillysClient } from "../willys/client.ts";

// Picks and books the earliest free pickup slot inside the household's
// window. Returns a human description of the slot, or null when none fits.
export async function bookPickupSlot(willys: WillysClient, household: Household): Promise<string | null> {
  const slots = await willys.pickupSlots(household.config.willys.storeId);
  throw new Error(`Pickup slot format not mapped yet: ${JSON.stringify(slots).slice(0, 300)}`);
}
