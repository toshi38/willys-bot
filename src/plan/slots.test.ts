import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Household } from "../core/household.ts";
import type { PickupSlot } from "../willys/types.ts";
import { pickSlot } from "./slots.ts";

const household = { config: { pickup: { weekdays: ["fri"], earliest: "18:00", latest: "20:00" } } } as unknown as Household;

// Stockholm is UTC+1 in late October, after the clocks went back.
const slot = (code: string, startUtc: string, endUtc: string, over: Partial<PickupSlot> = {}): PickupSlot => ({
  code,
  startTime: Date.parse(startUtc),
  endTime: Date.parse(endUtc),
  closeTime: Date.parse("2026-10-30T11:00:00Z"),
  available: true,
  formattedTime: code,
  ...over,
});
const now = Date.parse("2026-10-29T06:00:00Z");

test("the earliest free slot inside the window on the pickup day is picked", () => {
  const slots = [
    slot("fri-1630", "2026-10-30T15:30:00Z", "2026-10-30T17:00:00Z"),
    slot("fri-1900", "2026-10-30T18:00:00Z", "2026-10-30T19:00:00Z"),
    slot("fri-1800", "2026-10-30T17:00:00Z", "2026-10-30T18:30:00Z"),
    slot("thu-1800", "2026-10-29T17:00:00Z", "2026-10-29T18:30:00Z"),
  ];
  assert.equal(pickSlot(slots, household, "2026-10-30", now)?.code, "fri-1800");
});

test("taken slots, slots past their order cutoff and slots running past the window are skipped", () => {
  const slots = [
    slot("taken", "2026-10-30T17:00:00Z", "2026-10-30T18:30:00Z", { available: false }),
    slot("closed", "2026-10-30T17:00:00Z", "2026-10-30T18:30:00Z", { closeTime: Date.parse("2026-10-29T05:00:00Z") }),
    slot("late", "2026-10-30T18:30:00Z", "2026-10-30T20:00:00Z"),
  ];
  assert.equal(pickSlot(slots, household, "2026-10-30", now), null);
});
