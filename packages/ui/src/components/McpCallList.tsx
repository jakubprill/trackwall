import type { McpCall } from "@trackwall/protocol";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { filterMcpCalls, MCP_CALL_FILTERS, type McpCallFilter, mcpCallEntry } from "@/lib/mcp-calls";

/**
 * The MCP tool calls of the audit (ADR-152), newest first, with a filter for the calls that write or run something and
 * for the failed ones; Settings shows every caller's, a task's panel only its sessions'.
 */
export function McpCallList({ calls, showCaller }: { calls: readonly McpCall[]; showCaller: boolean }) {
  const [filter, setFilter] = useState<McpCallFilter>("all");
  const shown = filterMcpCalls(calls, filter);
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      <fieldset aria-label="Show calls" className="flex gap-1">
        {MCP_CALL_FILTERS.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={f.id === filter ? "secondary" : "ghost"}
            aria-pressed={f.id === filter}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </fieldset>
      {shown.length === 0 && <p className="text-muted-foreground text-sm">No calls.</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((call, i) => {
          const entry = mcpCallEntry(call, now);
          // Calls carry no id; the same tool can end twice in one millisecond, so the position tells them apart.
          return (
            <li key={`${call.at}-${call.tool}-${i}`} className="flex min-w-0 flex-col gap-0.5 border-b pb-2 last:border-b-0">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{entry.tool}</span>
                {entry.effect && <Badge variant={call.effect === "destructive" ? "destructive" : "secondary"}>{entry.effect}</Badge>}
                {showCaller && <span className="text-muted-foreground text-xs">{entry.caller}</span>}
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">{entry.when}</span>
              </span>
              {entry.args && <span className="text-muted-foreground font-mono text-xs break-all">{entry.args}</span>}
              {entry.failed && <span className="text-destructive font-mono text-xs break-words">{entry.outcome}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
