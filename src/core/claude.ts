import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
}

export async function runClaude(ctx: Context, run: ClaudeRun): Promise<unknown> {
  const mcpConfig = join(ctx.store.dir, `mcp-${run.readOnly ? "read" : "write"}.json`);
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
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: string };
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
