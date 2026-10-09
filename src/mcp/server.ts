import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openContext } from "../core/context.ts";
import { householdId } from "../core/household.ts";
import { buildServer } from "./tools.ts";

// Local MCP server over stdio, for Claude Code or Claude Desktop on a
// machine that has the household's data. --member names who is talking so
// list items record who added them.

const { values } = parseArgs({ options: { household: { type: "string" }, member: { type: "string" }, "read-only": { type: "boolean" } } });
const ctx = openContext(householdId(values.household));
const member = values.member ?? process.env.WILLYS_BOT_MEMBER ?? ctx.household.config.members[0].name;
const server = buildServer(ctx, member, { readOnly: values["read-only"] ?? false });
await server.connect(new StdioServerTransport());

const shutdown = () => {
  ctx.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
