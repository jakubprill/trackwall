import type { McpAuditRevision } from "@trackwall/protocol";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { McpCallList } from "@/components/McpCallList";
import { Surface } from "@/components/Surface";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { useMcpCalls } from "@/lib/use-mcp-calls";

/** The MCP audit (ADR-152): every tool call agents made to Trackwall, who made it and how it ended. */
export function McpCallsSurface({ conn, live }: { conn: Connection; live: LiveFeed<McpAuditRevision> | undefined }) {
  const audit = useMcpCalls(conn, live);
  const calls = audit.data?.calls;
  return (
    <Surface label="MCP calls" meta={calls && calls.length > 0 ? String(calls.length) : undefined}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Every call an agent made to Trackwall's tools, newest first: which agent, the repo, task or mise task it named, and how the call
          ended. Prompts, messages, request bodies and search text are not kept. The last 500 calls stay on this computer, also after a
          restart.
        </p>
        {audit.error && <ErrorWithRetry message={audit.error} onRetry={audit.reload} />}
        {!calls && !audit.error && <Loading />}
        {calls && <McpCallList calls={calls} showCaller />}
      </div>
    </Surface>
  );
}
