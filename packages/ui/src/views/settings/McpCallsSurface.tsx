import { MCP_AUDIT_MAX_CALLS, type McpAuditRevision, type McpCall } from "@trackwall/protocol";
import { useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { McpCallEffectBadge } from "@/components/McpCallEffectBadge";
import { McpCallKindFilter } from "@/components/McpCallKindFilter";
import { Surface } from "@/components/Surface";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { filterMcpCalls, type McpCallQuery, mcpCallChoices, mcpCallEntry, mcpCallKey } from "@/lib/mcp-calls";
import { useMcpCalls } from "@/lib/use-mcp-calls";

/**
 * The MCP audit (ADR-152) in Settings › Usage (ADR-212): every tool call agents made to Trackwall, one line each in a
 * table that scrolls in its own box, narrowed by kind, tool and agent.
 */
export function McpCallsSurface({ conn, live }: { conn: Connection; live: LiveFeed<McpAuditRevision> | undefined }) {
  const audit = useMcpCalls(conn, live);
  const calls = audit.data?.calls;
  return (
    <Surface label="MCP calls" meta={calls && calls.length > 0 ? String(calls.length) : undefined}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Every call an agent made to Trackwall's tools, newest first: which agent, the repo, task or mise task it named, and how the call
          ended. Prompts, messages, request bodies and search text are not kept. The last {MCP_AUDIT_MAX_CALLS} calls stay on this computer,
          also after a restart.
        </p>
        {audit.error && <ErrorWithRetry message={audit.error} onRetry={audit.reload} />}
        {!calls && !audit.error && <Loading />}
        {calls && <McpCallTable calls={calls} />}
      </div>
    </Surface>
  );
}

function McpCallTable({ calls }: { calls: readonly McpCall[] }) {
  const [query, setQuery] = useState<McpCallQuery>({ show: "all", tool: null, caller: null });
  const choices = mcpCallChoices(calls, query);
  const shown = filterMcpCalls(calls, query);
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <McpCallKindFilter value={query.show} onChange={(show) => setQuery((q) => ({ ...q, show }))} />
        <Choice label="Tool" value={query.tool} options={choices.tools} onChange={(tool) => setQuery((q) => ({ ...q, tool }))} />
        <Choice label="Agent" value={query.caller} options={choices.callers} onChange={(caller) => setQuery((q) => ({ ...q, caller }))} />
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">No calls.</p>
      ) : (
        <section aria-label="MCP calls" className="max-h-112 overflow-auto rounded-md border">
          <table className="w-full text-left text-xs">
            <thead className="bg-card sticky top-0">
              <tr className="border-b">
                {["When", "Tool", "Agent", "Arguments", "Result"].map((h) => (
                  <th key={h} scope="col" className="hud-label px-2 py-1.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((call, i) => {
                const entry = mcpCallEntry(call, now);
                return (
                  <tr key={mcpCallKey(call, i)} className="border-b align-top last:border-b-0">
                    <td className="text-muted-foreground px-2 py-1.5 whitespace-nowrap">{entry.when}</td>
                    <td className="px-2 py-1.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono">{entry.tool}</span>
                        <McpCallEffectBadge effect={call.effect} label={entry.effect} />
                      </span>
                    </td>
                    <td className="text-muted-foreground px-2 py-1.5 whitespace-nowrap">{entry.caller}</td>
                    <td className="text-muted-foreground px-2 py-1.5 font-mono break-all">{entry.args}</td>
                    <td className="px-2 py-1.5">
                      {entry.error ? (
                        <span className="text-destructive font-mono break-words">{entry.error}</span>
                      ) : (
                        <span className="text-muted-foreground">ok</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** A filter of one tool or one agent; "any" is no filter. */
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly string[];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="border-input bg-card h-8 max-w-56 min-w-0 truncate rounded-md border px-2 text-sm"
      >
        <option value="">any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
