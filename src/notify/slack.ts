import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Household } from "../core/household.ts";

// Posting to the household's Slack through the slack-gateway on the same
// machine, over its Unix socket. Slack is an extra channel next to email:
// when the gateway is not running, nothing is posted and email carries on.

export interface SlackButton {
  action: string;
  label: string;
  value: string;
  style?: "primary" | "danger";
}

export interface SlackRef {
  channel: string;
  ts: string;
}

export function slackSocket(): string {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
  return process.env.SLACK_GATEWAY_SOCKET ?? join(runtime, "slack-gateway.sock");
}

// With threadTs and broadcast, the reply is also shown in the channel.
export async function postToSlack(household: Household, text: string, opts: { buttons?: SlackButton[]; threadTs?: string; broadcast?: boolean } = {}): Promise<SlackRef | null> {
  const bot = household.config.slack?.bot;
  if (!bot || !existsSync(slackSocket())) return null;
  return (await call("/post", { bot, text, buttons: opts.buttons ?? [], threadTs: opts.threadTs, broadcast: opts.broadcast ?? false })) as SlackRef;
}

// False when nothing was updated because the gateway is not running.
export async function updateSlack(household: Household, ref: SlackRef, text: string, buttons: SlackButton[] = []): Promise<boolean> {
  const bot = household.config.slack?.bot;
  if (!bot || !existsSync(slackSocket())) return false;
  await call("/update", { bot, channel: ref.channel, ts: ref.ts, text, buttons });
  return true;
}

function call(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: slackSocket(), path, method: "POST", headers: { "Content-Type": "application/json" }, timeout: 30_000 }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => {
        const parsed = (() => {
          try {
            return JSON.parse(raw) as { error?: string };
          } catch {
            return { error: raw.slice(0, 200) };
          }
        })();
        if (res.statusCode !== 200) reject(new Error(`slack-gateway ${path} failed (${res.statusCode}): ${parsed.error ?? "no details"}`));
        else resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`slack-gateway ${path} timed out`)));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
