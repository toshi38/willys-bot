import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { sendToMembers, type OutgoingEmail } from "../notify/email.ts";
import { postToSlack, type SlackButton, type SlackRef } from "../notify/slack.ts";

// One Slack thread per weekly shop. The shop a moment belongs to is the
// next pickup, so after Friday's pickup changes go into next week's thread.
// Everything about that shop lands in its thread: list, pantry and
// preference changes from any source, the emails food-bot sends and
// answers, each plan (also shown in the channel), decisions and the
// filled cart. Households without Slack get email only.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const weekKey = (pickup: Date) => `slack.week.${localDate(pickup)}`;
const STARTING = "starting";

// The next pickup day on or after `now`, still today until the pickup
// window has closed.
export function nextPickup(household: Household, now = new Date()): Date {
  const { weekdays, latest } = household.config.pickup;
  const [h, m] = latest.split(":").map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!weekdays.includes(WEEKDAYS[d.getDay()])) continue;
    if (i === 0 && now.getHours() * 60 + now.getMinutes() >= h * 60 + m) continue;
    return d;
  }
  throw new Error("no pickup day in the next week");
}

// The thread for the shop `now` belongs to, started on first use. Only the
// process that claims the week starts its thread; another one running at
// the same moment waits for it.
export async function weekThread(ctx: Context, now = new Date()): Promise<SlackRef | null> {
  const pickup = nextPickup(ctx.household, now);
  const key = weekKey(pickup);
  if (!ctx.store.claim(key, STARTING)) {
    for (let i = 0; i < 20; i++) {
      const saved = ctx.store.get(key);
      if (saved && saved !== STARTING) return JSON.parse(saved) as SlackRef;
      if (!saved) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }
  const label = pickup.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  try {
    const ref = await postToSlack(
      ctx.household,
      `**Weekly shop: pickup ${label}**\nEverything about this shop goes in this thread: the plan, changes to the list, pantry and preferences, emails, and the order.`,
    );
    if (ref) ctx.store.set(key, JSON.stringify(ref));
    else ctx.store.delete(key);
    return ref;
  } catch (err) {
    ctx.store.delete(key);
    throw err;
  }
}

// Posts in this week's thread. Null when the household has no Slack.
export async function postToWeek(ctx: Context, text: string, opts: { buttons?: SlackButton[]; broadcast?: boolean } = {}): Promise<SlackRef | null> {
  const thread = await weekThread(ctx);
  if (!thread) return null;
  const ref = await postToSlack(ctx.household, text, { ...opts, threadTs: thread.ts });
  return ref && { channel: thread.channel, ts: ref.ts };
}

// Emails the household and posts the same in this week's thread, so Slack
// and email carry the same news. `slackText` replaces the email text in
// Slack when the thread needs more context, such as the email being
// answered.
export async function tellHousehold(ctx: Context, email: OutgoingEmail, slackText?: string): Promise<string> {
  const messageId = await sendToMembers(ctx.household, email);
  await toSlack(() => postToWeek(ctx, slackText ?? `**${email.subject.replace(/\s*\[wb:[0-9a-f]+\]$/, "")}**\n\n${email.markdown}`));
  return messageId;
}

// Posts the changes logged since the last post as one message in this
// week's thread. Changes older than a week are dropped rather than posted
// late into the wrong shop.
export async function postChanges(ctx: Context): Promise<void> {
  if (!ctx.household.config.slack) return;
  const changes = ctx.store.claimChanges();
  if (!changes.length) return;
  const cutoff = Date.now() - 7 * 86_400_000;
  const fresh = changes.filter((c) => new Date(c.at).getTime() >= cutoff);
  if (!fresh.length) return;
  try {
    const ref = await postToWeek(ctx, ["**Changes**", ...fresh.map((c) => `- ${c.by} ${c.text}`)].join("\n"));
    if (!ref) ctx.store.releaseChanges(fresh.map((c) => c.id));
  } catch (err) {
    ctx.store.releaseChanges(fresh.map((c) => c.id));
    throw err;
  }
}

// Slack is an extra channel: a failure there is logged and never stops the
// email flow or a decision.
export async function toSlack(f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (err) {
    console.error(`Slack: ${err instanceof Error ? err.message : err}`);
  }
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
