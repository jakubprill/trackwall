import { DAEMON_INFO_PATH, DaemonInfo, mcpTools } from "@trackwall/protocol";
import { useCallback } from "react";
import { CopyableCode } from "@/components/CopyableCode";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { call } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { copilotMcpAddCommand, copilotMcpConfig, copilotMcpConfigPath } from "@/lib/copilot-mcp";
import { useRemote } from "@/lib/use-remote";

const TOOL_NAMES = Object.values(mcpTools).map((t) => t.name);

/**
 * How to connect the Trackwall MCP server to Copilot CLI (§5.3, ADR-24): a command to copy and the same entry in JSON.
 * The UI writes nothing into the Copilot CLI config; `copilot mcp add` does that on the user's side.
 */
export function ConnectCopilotSurface({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const load = useCallback(() => call(conn, DAEMON_INFO_PATH, DaemonInfo), [conn]);
  const info = useRemote(load);
  if (info.data) return <ConnectCopilot info={info.data} />;
  return (
    <div className="p-4">
      {info.error ? (
        <ErrorWithRetry
          message={info.error}
          onRetry={() => {
            onRetry();
            info.reload();
          }}
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}

function ConnectCopilot({ info }: { info: DaemonInfo }) {
  const command = copilotMcpAddCommand(info.mcpStdioCommand, info.platform);
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p className="text-muted-foreground">
        Optional: the sessions you start in Trackwall already have these tools. For Copilot CLI you start yourself in a terminal, this gives
        the agent a map of the repos in your projects folder through {TOOL_NAMES.length} tools. Run it once in a terminal, then restart
        Copilot CLI:
      </p>
      <CopyableCode text={command} />
      {/* Folded (ADR-212): the list and the JSON entry are long, and most people need neither once connected. */}
      <details>
        <summary className="text-muted-foreground cursor-pointer">Or add an entry to {copilotMcpConfigPath(info.platform)}</summary>
        <div className="pt-2">
          <CopyableCode text={copilotMcpConfig(info.mcpStdioCommand)} />
        </div>
      </details>
      <details>
        <summary className="text-muted-foreground cursor-pointer">The {TOOL_NAMES.length} tools</summary>
        <p className="text-muted-foreground pt-2 font-mono text-xs">{TOOL_NAMES.join(", ")}</p>
      </details>
      <p className="text-muted-foreground text-xs">The tools are read-only. Trackwall must be running when Copilot CLI starts.</p>
    </div>
  );
}
