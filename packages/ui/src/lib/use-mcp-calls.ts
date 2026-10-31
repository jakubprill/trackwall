import { type McpAuditRevision, mcpAuditApi } from "@trackwall/protocol";
import { useCallback, useEffect, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/** Without the events, or for a view that does not get them (a task's tab), the list is read again this often. */
const POLL_MS = 5000;
/** While the events are live, a new call comes at once as a new revision (`mcp.calls.changed`, ADR-152). */
const LIVE_POLL_MS = 60_000;

/** The MCP audit's calls, newest first; with `task`, only those of that task's sessions. */
export function useMcpCalls(conn: Connection, live: LiveFeed<McpAuditRevision> | undefined, task?: string) {
  const [revision, setRevision] = useState<number>();
  useEffect(() => live?.subscribe((audit) => setRevision(audit.revision)), [live]);
  const load = useCallback(() => post(conn, mcpAuditApi.calls, task === undefined ? {} : { task }), [conn, task]);
  return useRemote(load, { refreshKey: String(revision ?? ""), pollMs: () => (live?.isLive() ? LIVE_POLL_MS : POLL_MS) });
}
