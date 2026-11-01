import { type McpAuditRevision, mcpAuditApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRevisionRemote } from "./use-revision-remote.ts";

/**
 * A new call comes at once as a new revision (`mcp.calls.changed`, ADR-152), so polling while the events are live is
 * only a fallback; without them, or in a view that does not get them (a task's tab), the list is read every 5 s.
 */
const PACE = { livePollMs: 60_000, pollMs: 5000 };

/** The MCP audit's calls, newest first; with `task`, only those of that task's sessions. */
export function useMcpCalls(conn: Connection, live: LiveFeed<McpAuditRevision> | undefined, task?: string) {
  const load = useCallback(() => post(conn, mcpAuditApi.calls, task === undefined ? {} : { task }), [conn, task]);
  return useRevisionRemote(load, live, PACE);
}
