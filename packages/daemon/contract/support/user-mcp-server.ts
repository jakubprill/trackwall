/**
 * A stand-in for one of the user's own MCP servers (an issue tracker, a repo host) in the contract tests (ADR-70): a
 * stdio MCP server with one read-only tool, `list_issues`, answering newline-delimited JSON-RPC by hand, so it needs
 * nothing but the runtime. Copilot CLI loads it from the user's `mcp-config.json`, next to Trackwall's server.
 */
import { createInterface } from "node:readline";
import { z } from "zod";

export const USER_MCP_SERVER = "tracker";
export const USER_MCP_TOOL = "list_issues";
export const USER_MCP_ISSUES = "SHOP-12 Refunds are rounded wrongly";

const Request = z.looseObject({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.looseObject({ protocolVersion: z.string().optional() }).optional(),
});
type Request = z.infer<typeof Request>;

/** The answer's `result` or `error` member. */
function answerOf(message: Request): { result: unknown } | { error: { code: number; message: string } } {
  switch (message.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: USER_MCP_SERVER, version: "1" },
        },
      };
    case "tools/list":
      return {
        result: {
          tools: [
            {
              name: USER_MCP_TOOL,
              description: "List the user's open issues",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      };
    case "tools/call":
      return { result: { content: [{ type: "text", text: USER_MCP_ISSUES }] } };
    default:
      return { error: { code: -32601, message: "Method not found" } };
  }
}

function answer(line: string): void {
  const message = Request.parse(JSON.parse(line));
  // A notification has no id and gets no answer.
  if (message.id === undefined || message.id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answerOf(message) })}\n`);
}

if (import.meta.main) createInterface({ input: process.stdin }).on("line", (line) => line.trim() !== "" && answer(line));
