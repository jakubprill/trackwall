import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { PathForm } from "@/components/PathForm";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useDesktop } from "@/lib/desktop";
import { daemonExamplePaths } from "@/lib/platform";
import type { RemoteHandle } from "@/lib/use-remote";
import { SettingsRead } from "./SettingsRead.tsx";

/** The git the daemon starts for local git calls (ADR-112); empty means git from `PATH`. */
export function GitProgramSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  const example = daemonExamplePaths(useDesktop()).gitProgram;

  async function save(path: string | null) {
    await post(conn, workspaceApi.setGitProgram, { path });
    settings.reload();
  }

  const data = settings.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">
        The git Trackwall runs to read your repos: status, history, repo cards and task worktrees. Empty means git from PATH. Choose another
        one, for example MinGit unpacked into a folder your antivirus skips, when starting git is slow on this machine. Fetch, push and
        clone always use git from PATH, so your sign-in keeps working.
      </p>
      <SettingsRead settings={settings} />
      {data && (
        <PathForm
          key={data.gitProgram ?? ""}
          label="Full path to git"
          placeholder={example}
          configKey="gitProgram"
          initialPath={data.gitProgram ?? ""}
          configFile={data.configFile}
          folder={false}
          save={(path) => save(path)}
          reset={data.gitProgram === null && !data.gitProgramProblem ? undefined : () => save(null)}
        />
      )}
      {data?.gitProgramProblem && <p className="text-destructive text-xs break-words">{data.gitProgramProblem}</p>}
    </div>
  );
}
