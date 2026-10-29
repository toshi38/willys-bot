import type { Household } from "../core/household.ts";
import type { WillysClient } from "../willys/client.ts";
import type { PickupSlot } from "../willys/types.ts";

// Picks the earliest free click-and-collect slot on the pickup day that
// starts inside the household's window, puts it on the cart and checks that
// it stuck. Null when none fits.
export async function bookPickupSlot(willys: WillysClient, household: Household, pickupDate: string, now = Date.now()): Promise<PickupSlot | null> {
  const { slots } = await willys.pickupSlots(household.config.willys.storeId);
  const slot = pickSlot(slots, household, pickupDate, now);
  if (!slot) return null;
  await willys.selectPickupSlot(slot.code);
  const booked = await willys.slotInCart();
  if (booked?.code !== slot.code) throw new Error(`Willys did not keep the pickup slot ${slot.formattedTime} on the cart`);
  return slot;
}

const TZ = "Europe/Stockholm";
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function pickSlot(slots: PickupSlot[], household: Household, pickupDate: string, now = Date.now()): PickupSlot | null {
  const { weekdays, earliest, latest } = household.config.pickup;
  return (
    slots
      .filter((s) => s.available && s.closeTime > now)
      .filter((s) => local(s.startTime).date === pickupDate && weekdays.includes(local(s.startTime).weekday as (typeof weekdays)[number]))
      // Slots can be wider than the window (Friday evening is 18:00-21:00),
      // so a slot fits when it starts inside the window.
      .filter((s) => local(s.startTime).time >= earliest && local(s.startTime).time < latest)
      .sort((a, b) => a.startTime - b.startTime)[0] ?? null
  );
}

// Date, weekday and HH:MM of a moment in the store's time zone.
function local(ms: number): { date: string; weekday: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)], time: `${parts.hour}:${parts.minute}` };
}
