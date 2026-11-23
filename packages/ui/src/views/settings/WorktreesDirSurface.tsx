import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { PathForm } from "@/components/PathForm";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { RemoteHandle } from "@/lib/use-remote";
import { SettingsRead } from "./SettingsRead.tsx";

/** Where new task worktrees go (ADR-84); empty means `.trackwall/worktrees` in the projects folder. */
export function WorktreesDirSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  async function save(path: string | null) {
    await post(conn, workspaceApi.setWorktreesDir, { path });
    settings.reload();
  }

  const data = settings.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">
        Each agent task works in its own git worktree in this folder. Keep it on the same fast disk as your repos and inside the folders
        your antivirus skips, or git and builds in a task get slow. Tasks you already have keep their worktrees where they are.
      </p>
      <SettingsRead settings={settings} />
      {data && (
        <PathForm
          key={data.worktreesDir ?? ""}
          label="Full path to the task worktrees folder"
          placeholder={data.defaultWorktreesDir ?? "Set the projects folder first"}
          configKey="worktreesDir"
          initialPath={data.worktreesDir ?? ""}
          configFile={data.configFile}
          save={(path) => save(path)}
          reset={data.worktreesDir === null && !data.worktreesDirProblem ? undefined : () => save(null)}
        />
      )}
      {data?.worktreesDirProblem && <p className="text-destructive text-xs break-words">{data.worktreesDirProblem}</p>}
      {data && data.worktreesDir === null && !data.worktreesDirProblem && data.defaultWorktreesDir && (
        <p className="text-muted-foreground text-xs break-all">
          Empty: new tasks use <span className="font-mono">{data.defaultWorktreesDir}</span>, which the Repos view does not list.
        </p>
      )}
    </div>
  );
}
