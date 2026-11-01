import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { McpCallList } from "@/components/McpCallList";
import type { Connection } from "@/lib/connection";
import { useMcpCalls } from "@/lib/use-mcp-calls";

/** The task's "MCP calls" tab (ADR-152): what its sessions' agents asked Trackwall for and ran through it. */
export function TaskMcpCalls({ conn, task }: { conn: Connection; task: string }) {
  const audit = useMcpCalls(conn, undefined, task);
  if (audit.error) return <ErrorWithRetry message={audit.error} onRetry={audit.reload} />;
  if (!audit.data) return <Loading />;
  return <McpCallList calls={audit.data.calls} showCaller={false} />;
}
