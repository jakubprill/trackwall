import type { McpCall } from "@trackwall/protocol";
import { useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { McpCallEffectBadge } from "@/components/McpCallEffectBadge";
import { McpCallKindFilter } from "@/components/McpCallKindFilter";
import type { Connection } from "@/lib/connection";
import { filterMcpCalls, type McpCallFilter, mcpCallEntry, mcpCallKey } from "@/lib/mcp-calls";
import { useMcpCalls } from "@/lib/use-mcp-calls";

/** The task's "MCP calls" tab (ADR-152): what its sessions' agents asked Trackwall for and ran through it. */
export function TaskMcpCalls({ conn, task }: { conn: Connection; task: string }) {
  const audit = useMcpCalls(conn, undefined, task);
  if (audit.error) return <ErrorWithRetry message={audit.error} onRetry={audit.reload} />;
  if (!audit.data) return <Loading />;
  return <TaskMcpCallList calls={audit.data.calls} />;
}

/** Newest first, one call under another, as the narrow panel has room for; every call is the task's, so no caller. */
function TaskMcpCallList({ calls }: { calls: readonly McpCall[] }) {
  const [show, setShow] = useState<McpCallFilter>("all");
  const shown = filterMcpCalls(calls, { show, tool: null, caller: null });
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      <McpCallKindFilter value={show} onChange={setShow} />
      {shown.length === 0 && <p className="text-muted-foreground text-sm">No calls.</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((call, i) => {
          const entry = mcpCallEntry(call, now);
          return (
            <li key={mcpCallKey(call, i)} className="flex min-w-0 flex-col gap-0.5 border-b pb-2 last:border-b-0">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{entry.tool}</span>
                <McpCallEffectBadge effect={call.effect} label={entry.effect} />
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">{entry.when}</span>
              </span>
              {entry.args && <span className="text-muted-foreground font-mono text-xs break-all">{entry.args}</span>}
              {entry.error && <span className="text-destructive font-mono text-xs break-words">{entry.error}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
