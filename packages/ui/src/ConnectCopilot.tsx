import type { DaemonInfo } from "@trackwall/protocol";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { copilotMcpAddCommand, copilotMcpConfig } from "@/lib/copilot-mcp";

/**
 * Jak podłączyć serwer MCP Trackwall do Copilot CLI (§5.3, ADR-22): komenda do skopiowania i ten sam wpis w JSON.
 * UI niczego nie zapisuje w konfiguracji Copilot CLI; robi to `copilot mcp add` po stronie użytkownika.
 */
export function ConnectCopilot({ info }: { info: DaemonInfo }) {
  const command = copilotMcpAddCommand(info.mcpStdioCommand, info.platform);
  return (
    <Surface label="Copilot CLI" note="Narzędzia tylko czytają. Trackwall musi działać, kiedy startuje Copilot CLI.">
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p className="text-muted-foreground">
          Daje agentowi mapę repo z folderu z projektami (list_repos, get_repo). Uruchom raz w terminalu, potem zrestartuj Copilot CLI:
        </p>
        <CopyableCode text={command} />
        <p className="text-muted-foreground">Albo dopisz wpis do ~/.copilot/mcp-config.json:</p>
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
        aria-label={copied ? "Skopiowano" : "Kopiuj"}
        title={copied ? "Skopiowano" : "Kopiuj"}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
