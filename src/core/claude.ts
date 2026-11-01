import { spawn } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";

// Headless Claude Code (`claude -p`) on the operator's Claude subscription,
// with this project's MCP server as its only tools and a JSON schema for
// its answer.

export interface ClaudeRun {
  systemPrompt: string;
  prompt: string;
  schema: object;
  // MCP tool names without the mcp__willys__ prefix.
  tools: string[];
  // Who the MCP server records as making changes.
  member: string;
  readOnly: boolean;
  // The week the week tools work on, instead of the open one.
  week?: string;
}

export async function runClaude(ctx: Context, run: ClaudeRun): Promise<unknown> {
  // One config file per run, since runs for different weeks or members can
  // overlap.
  const mcpConfig = join(ctx.store.dir, `mcp-${process.pid}-${Date.now()}.json`);
  const root = new URL("../../", import.meta.url).pathname;
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        willys: {
          type: "stdio",
          command: process.execPath,
          args: [
            "--no-warnings=ExperimentalWarning",
            join(root, "src/mcp/server.ts"),
            "--household", ctx.household.id,
            "--member", run.member,
            ...(run.readOnly ? ["--read-only"] : []),
            ...(run.week ? ["--week", run.week] : []),
          ],
          env: { ...(process.env.WILLYS_BOT_DATA ? { WILLYS_BOT_DATA: process.env.WILLYS_BOT_DATA } : {}), ...(process.env.WILLYS_BOT_HOUSEHOLDS ? { WILLYS_BOT_HOUSEHOLDS: process.env.WILLYS_BOT_HOUSEHOLDS } : {}) },
        },
      },
    }),
  );
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--setting-sources", "",
    "--model", process.env.WILLYS_BOT_MODEL ?? "sonnet",
    "--system-prompt", run.systemPrompt,
    "--json-schema", JSON.stringify(run.schema),
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", run.tools.map((t) => `mcp__willys__${t}`).join(","),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      rmSync(mcpConfig, { force: true });
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(mcpConfig, { force: true });
      try {
        const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: string; total_cost_usd?: number; duration_ms?: number; num_turns?: number };
        // Cost and time per run, when asked for (the evals compare models).
        if (process.env.WILLYS_BOT_USAGE_LOG) {
          appendFileSync(process.env.WILLYS_BOT_USAGE_LOG, `${JSON.stringify({ model: args[args.indexOf("--model") + 1], costUsd: out.total_cost_usd ?? null, durationMs: out.duration_ms ?? null, turns: out.num_turns ?? null })}\n`);
        }
        if (out.is_error || code !== 0) return reject(new Error(`claude exited ${code}: ${out.result ?? stderr}`));
        if (out.structured_output === undefined) return reject(new Error("claude returned no structured output"));
        resolve(out.structured_output);
      } catch {
        reject(new Error(`claude exited ${code} with unparseable output: ${(stderr || stdout).slice(0, 500)}`));
      }
    });
    child.stdin.end(run.prompt);
  });
}
