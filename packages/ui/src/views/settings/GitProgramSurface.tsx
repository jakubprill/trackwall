import type { WorkspaceSettings } from "@trackwall/protocol";
import { Surface } from "@/components/Surface";
import { PathForm } from "./PathForm.tsx";

/** The git the daemon starts for local git calls (ADR-112); empty means git from `PATH`. */
export function GitProgramSurface({ settings, save }: { settings: WorkspaceSettings; save: (path: string | null) => Promise<void> }) {
  return (
    <Surface label="Git program">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The git Trackwall runs to read your repos: status, history, repo cards and task worktrees. Empty means git from PATH. Choose
          another one, for example MinGit unpacked into your projects folder, when starting git is slow on this machine. Fetch, push and
          clone always use git from PATH, so your sign-in keeps working.
        </p>
        <PathForm
          key={settings.gitProgram ?? ""}
          label="Full path to git"
          placeholder={"C:\\Users\\me\\Dev\\tools\\MinGit\\cmd\\git.exe"}
          configKey="gitProgram"
          initialPath={settings.gitProgram ?? ""}
          configFile={settings.configFile}
          folder={false}
          save={(path) => save(path)}
          reset={settings.gitProgram === null && !settings.gitProgramProblem ? undefined : () => save(null)}
        />
        {settings.gitProgramProblem && <p className="text-destructive text-xs break-words">{settings.gitProgramProblem}</p>}
      </div>
    </Surface>
  );
}
