import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { SavedAs } from "@/components/SavedAs";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import type { RemoteHandle } from "@/lib/use-remote";
import { SettingsRead } from "./SettingsRead.tsx";

/**
 * Whether the daemon asks the repos' servers for new commits every 15 minutes (`serverCheck`, ADR-295). On by default:
 * it fetches nothing and runs nothing a repo's configuration names, and "All repos" marks the repos with news.
 */
export function ServerCheckSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  const save = useAction((on: boolean) => post(conn, workspaceApi.setServerCheck, { on }), settings.reload);

  const data = settings.data;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-muted-foreground text-sm">
        Every 15 minutes Trackwall asks the server of each repo's branch whether it has commits the repo has not fetched, and All repos
        marks such a repo "new on the server". It fetches nothing and changes nothing in your repos: Pull or Sync all brings the commits. It
        asks with your own sign-in for git, as a terminal would, but from outside the repo, so nothing a repo's own git configuration names
        runs. Turn it off if you would rather Trackwall did not connect to your servers on its own.
      </p>
      <SettingsRead settings={settings} />
      {data && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary size-4 shrink-0"
            checked={data.serverCheck}
            disabled={save.pending}
            onChange={(e) => save.run(e.target.checked)}
          />
          Ask the servers every 15 minutes
        </label>
      )}
      {data?.serverCheckProblem && <p className="text-destructive text-xs break-words">{data.serverCheckProblem}</p>}
      {save.error && <p className="text-destructive text-xs break-words">{save.error}</p>}
      {data && <SavedAs configKey="serverCheck" configFile={data.configFile} />}
    </div>
  );
}
