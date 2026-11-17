import { type AlwaysAllowedTool, type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { Button } from "@/components/ui/button";
import { alwaysAllowedToolLabel } from "@/lib/always-allow";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import type { RemoteHandle } from "@/lib/use-remote";
import { SavedAs } from "./SavedAs.tsx";
import { SettingsRead } from "./SettingsRead.tsx";

/**
 * The tools "Always allow" remembered in an approval of a task (ADR-249), saved as `alwaysAllow` in `workspace.yaml`:
 * each repo's tasks run them without asking until the user removes one here.
 */
export function AlwaysAllowSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  const remove = useAction(
    (entry: AlwaysAllowedTool) => post(conn, workspaceApi.removeAlwaysAllowed, entry),
    () => settings.reload(),
  );

  const data = settings.data;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-muted-foreground text-sm">
        What you chose "Always allow" for when a task asked: every task of that repo runs it without asking. Only one command or one MCP
        tool at a time, never one that writes files by path, reaches the network or pushes. A removal applies at once to running tasks' next
        request, and Copilot CLI's own permission at the task's next start.
      </p>
      <SettingsRead settings={settings} />
      {data && data.alwaysAllow.length === 0 && !data.alwaysAllowProblem && (
        <p className="text-muted-foreground text-sm">
          Nothing yet. "Always allow" appears in a task's approval in the tray panel and on Home.
        </p>
      )}
      {data && data.alwaysAllow.length > 0 && (
        <ul aria-label="Always allowed tools" className="flex flex-col divide-y rounded-md border">
          {data.alwaysAllow.map((entry) => (
            <li key={`${entry.repo}\n${entry.tool}`} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-words">
                <span className="font-mono">{alwaysAllowedToolLabel(entry.tool)}</span>
                <span className="text-muted-foreground"> in {entry.repo}</span>
              </span>
              <Button size="sm" variant="outline" disabled={remove.pending} onClick={() => remove.run(entry)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {data?.alwaysAllowProblem && <p className="text-destructive text-xs break-words">{data.alwaysAllowProblem}</p>}
      {remove.error && <p className="text-destructive text-xs break-words">{remove.error}</p>}
      {data && <SavedAs configKey="alwaysAllow" configFile={data.configFile} />}
    </div>
  );
}
