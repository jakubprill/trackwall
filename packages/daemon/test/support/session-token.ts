import { readFileSync } from "node:fs";
import { z } from "zod";
import { SESSION_TOKEN_HEADER } from "../../src/mcp/endpoint.ts";
import { sessionMcpConfigFile } from "../../src/modules/agents/session-launcher.ts";

const McpConfig = z.object({
  mcpServers: z.object({ trackwall: z.object({ headers: z.object({ [SESSION_TOKEN_HEADER]: z.string() }) }) }),
});

/** The session token of session `id`, read where its Copilot CLI finds it: the Trackwall server's headers in its MCP configuration. */
export function sessionToken(home: string, id: string): string {
  return McpConfig.parse(JSON.parse(readFileSync(sessionMcpConfigFile(home, id), "utf8"))).mcpServers.trackwall.headers[
    SESSION_TOKEN_HEADER
  ];
}
