// Loaded into every process an integration test starts (the CLI, the
// stand-in Claude and the MCP server it runs, through NODE_OPTIONS), so they
// all see the same moment, NOW. The weekly cycle depends on the clock (which
// pickup is next, whether the order cutoff has passed), and tests that ran on
// the real one failed on some days and hours. Time still moves forward from
// NOW, so durations and timeouts behave as usual.

// Wednesday 07:00 in Stockholm, when the weekly plan normally runs; the next
// pickup is Friday 2026-11-06.
export const NOW = new Date("2026-11-04T07:00:00+01:00");

if (process.env.WILLYS_BOT_TEST_CLOCK === "1") {
  const RealDate = Date;
  const offset = NOW.getTime() - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
