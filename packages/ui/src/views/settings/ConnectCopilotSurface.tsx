import { DAEMON_INFO_PATH, DaemonInfo, mcpTools } from "@trackwall/protocol";
import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
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
    <Surface label="Copilot CLI">
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
    </Surface>
  );
}

function ConnectCopilot({ info }: { info: DaemonInfo }) {
  const command = copilotMcpAddCommand(info.mcpStdioCommand, info.platform);
  return (
    <Surface label="Copilot CLI" note="The tools are read-only. Trackwall must be running when Copilot CLI starts.">
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p className="text-muted-foreground">
          Gives the agent a map of the repos in your projects folder through {TOOL_NAMES.length} tools. Run this once in a terminal, then
          restart Copilot CLI:
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
      </div>
    </Surface>
  );
}

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="surface flex items-start gap-2 p-2">
      <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
