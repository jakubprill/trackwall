import type { WorkspaceSettings } from "@trackwall/protocol";
import { Surface } from "@/components/Surface";
import { PathForm } from "./PathForm.tsx";

/** Where new task worktrees go (ADR-84); empty means `.trackwall/worktrees` in the projects folder. */
export function WorktreesDirSurface({ settings, save }: { settings: WorkspaceSettings; save: (path: string | null) => Promise<void> }) {
  return (
    <Surface label="Task worktrees folder">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          Each agent task works in its own git worktree in this folder. Keep it on the same fast disk as your repos and inside the folders
          your antivirus skips, or git and builds in a task get slow. Tasks you already have keep their worktrees where they are.
        </p>
        <PathForm
          key={settings.worktreesDir ?? ""}
          label="Full path to the task worktrees folder"
          placeholder={settings.defaultWorktreesDir ?? "Set the projects folder first"}
          configKey="worktreesDir"
          initialPath={settings.worktreesDir ?? ""}
          configFile={settings.configFile}
          save={(path) => save(path)}
          reset={settings.worktreesDir === null && !settings.worktreesDirProblem ? undefined : () => save(null)}
        />
        {settings.worktreesDirProblem && <p className="text-destructive text-xs break-words">{settings.worktreesDirProblem}</p>}
        {settings.worktreesDir === null && !settings.worktreesDirProblem && settings.defaultWorktreesDir && (
          <p className="text-muted-foreground text-xs break-all">
            Empty: new tasks use <span className="font-mono">{settings.defaultWorktreesDir}</span>, which the Repos view does not list.
          </p>
        )}
      </div>
    </Surface>
  );
}
