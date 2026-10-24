import { type DaemonInfo, mcpTools } from "@trackwall/protocol";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { copilotMcpAddCommand, copilotMcpConfig, copilotMcpConfigPath } from "@/lib/copilot-mcp";

const TOOL_NAMES = Object.values(mcpTools)
  .map((t) => t.name)
  .join(", ");

/**
 * Jak podłączyć serwer MCP Trackwall do Copilot CLI (§5.3, ADR-24): komenda do skopiowania i ten sam wpis w JSON.
 * UI niczego nie zapisuje w konfiguracji Copilot CLI; robi to `copilot mcp add` po stronie użytkownika.
 */
export function ConnectCopilot({ info }: { info: DaemonInfo }) {
  const command = copilotMcpAddCommand(info.mcpStdioCommand, info.platform);
  return (
    <Surface label="Copilot CLI" note="The tools are read-only. Trackwall must be running when Copilot CLI starts.">
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p className="text-muted-foreground">
          Gives the agent a map of the repos in your projects folder ({TOOL_NAMES}). Run this once in a terminal, then restart Copilot CLI:
        </p>
        <CopyableCode text={command} />
        <p className="text-muted-foreground">Or add this entry to {copilotMcpConfigPath(info.platform)}:</p>
        <CopyableCode text={copilotMcpConfig(info.mcpStdioCommand)} />
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
