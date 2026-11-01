import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A stand-in for `claude -p` in integration tests. Each run takes the next
// turn from the script in FAKE_CLAUDE_SCRIPT: it calls the turn's tools on
// the real MCP server named in --mcp-config, then prints the turn's answer
// as Claude Code's JSON output. The prompt, system prompt and tool results
// are appended to FAKE_CLAUDE_LOG for the test to check.

export interface Turn {
  calls?: { tool: string; args?: Record<string, unknown> }[];
  output: unknown;
  // Makes the run fail the way Claude Code reports an error.
  error?: string;
}

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT!;
const counterPath = `${scriptPath}.next`;
const turns = JSON.parse(readFileSync(scriptPath, "utf8")) as Turn[];
const next = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(next + 1));
const turn = turns[next];
if (!turn) {
  console.log(JSON.stringify({ is_error: true, result: `fake claude: no turn ${next} in the script` }));
  process.exit(1);
}

const results: unknown[] = [];
if (turn.calls?.length) {
  const config = JSON.parse(readFileSync(arg("--mcp-config")!, "utf8")) as { mcpServers: { willys: { command: string; args: string[]; env?: Record<string, string> } } };
  const server = config.mcpServers.willys;
  const client = new Client({ name: "fake-claude", version: "1" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...(process.env as Record<string, string>), ...server.env } }));
  for (const call of turn.calls) {
    const res = (await client.callTool({ name: call.tool, arguments: call.args ?? {} })) as { isError?: boolean; content: { text: string }[] };
    results.push({ tool: call.tool, error: res.isError === true, text: res.content.map((c) => c.text).join("") });
  }
  await client.close();
}

appendFileSync(process.env.FAKE_CLAUDE_LOG!, `${JSON.stringify({ turn: next, model: arg("--model"), system: arg("--system-prompt"), prompt, results })}\n`);
if (turn.error) {
  console.log(JSON.stringify({ is_error: true, result: turn.error }));
  process.exit(1);
}
console.log(JSON.stringify({ is_error: false, structured_output: turn.output }));
