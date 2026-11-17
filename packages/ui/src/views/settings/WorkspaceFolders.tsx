import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import { GitProgramSurface } from "./GitProgramSurface.tsx";
import { ProjectsFolderForm } from "./ProjectsFolderForm.tsx";
import { WorktreesDirSurface } from "./WorktreesDirSurface.tsx";

/** The projects folder, the task worktrees folder and the git program; all come from one read of the workspace settings. */
export function WorkspaceFolders({ conn, onRetry, onSaved }: { conn: Connection; onRetry: () => void; onSaved: () => void }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

  async function saveProjectsDir(path: string) {
    await post(conn, workspaceApi.setProjectsDir, { path });
    settings.reload();
    onSaved();
  }

  async function saveWorktreesDir(path: string | null) {
    await post(conn, workspaceApi.setWorktreesDir, { path });
    settings.reload();
  }

  async function saveGitProgram(path: string | null) {
    await post(conn, workspaceApi.setGitProgram, { path });
    settings.reload();
  }

  return (
    <>
      <Surface label="Projects folder">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">
            The Repos view shows every git repo directly inside this folder. A repo cloned into it appears in the list on its own.
          </p>
          <ProjectsFolderForm conn={conn} settings={settings} save={saveProjectsDir} onRetry={onRetry} />
        </div>
      </Surface>
      {settings.data && <WorktreesDirSurface settings={settings.data} save={saveWorktreesDir} />}
      {settings.data && <GitProgramSurface settings={settings.data} save={saveGitProgram} />}
    </>
  );
}
