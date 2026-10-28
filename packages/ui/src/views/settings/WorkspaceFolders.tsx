import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { FolderForm } from "./FolderForm.tsx";

/** The projects folder and the task worktrees folder; both come from one read of the workspace settings. */
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

  return (
    <>
      <Surface label="Projects folder">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">
            The Repos view shows every git repo directly inside this folder. A repo cloned into it appears in the list on its own.
          </p>
          {settings.error && (
            <ErrorWithRetry
              message={settings.error}
              onRetry={() => {
                onRetry();
                settings.reload();
              }}
            />
          )}
          {!settings.data && !settings.error && <Loading />}
          {settings.data?.projectsDir === null && <SuggestedProjectsDir conn={conn} use={saveProjectsDir} />}
          {settings.data && (
            <FolderForm
              key={settings.data.projectsDir ?? ""}
              {...PROJECTS_DIR}
              initialPath={settings.data.projectsDir ?? ""}
              configFile={settings.data.configFile}
              save={(path) => saveProjectsDir(path)}
            />
          )}
          {/* A bad `projectsDir` typed by hand into `workspace.yaml` is fixed with this very form. */}
          {settings.errorCode === "invalid_config" && (
            <FolderForm {...PROJECTS_DIR} initialPath="" save={(path) => saveProjectsDir(path)} />
          )}
        </div>
      </Surface>
      {settings.data && (
        <Surface label="Task worktrees folder">
          <div className="flex flex-col gap-4 p-4">
            <p className="text-muted-foreground text-sm">
              Each agent task works in its own git worktree in this folder. Keep it on the same fast disk as your repos and inside the
              folders your antivirus skips, or git and builds in a task get slow. Tasks you already have keep their worktrees where they
              are.
            </p>
            <FolderForm
              key={settings.data.worktreesDir ?? ""}
              label="Full path to the task worktrees folder"
              placeholder={settings.data.defaultWorktreesDir ?? "Set the projects folder first"}
              configKey="worktreesDir"
              initialPath={settings.data.worktreesDir ?? ""}
              configFile={settings.data.configFile}
              save={(path) => saveWorktreesDir(path)}
              reset={settings.data.worktreesDir === null && !settings.data.worktreesDirProblem ? undefined : () => saveWorktreesDir(null)}
            />
            {settings.data.worktreesDirProblem && (
              <p className="text-destructive text-xs break-words">{settings.data.worktreesDirProblem}</p>
            )}
            {settings.data.worktreesDir === null && !settings.data.worktreesDirProblem && settings.data.defaultWorktreesDir && (
              <p className="text-muted-foreground text-xs break-all">
                Empty: new tasks use <span className="font-mono">{settings.data.defaultWorktreesDir}</span>, which the Repos view does not
                list.
              </p>
            )}
          </div>
        </Surface>
      )}
    </>
  );
}

/**
 * A folder of the home folder that looks like a projects folder (`Dev`, `Projects`…), offered with one button while none
 * is set, so that the usual case needs no typing or browsing.
 */
function SuggestedProjectsDir({ conn, use }: { conn: Connection; use: (path: string) => Promise<void> }) {
  const load = useCallback(() => post(conn, workspaceApi.suggestedProjectsDir, {}), [conn]);
  const suggestion = useRemote(load);
  const save = useAction(
    (path: string) => use(path),
    () => {},
  );
  if (!suggestion.data) return null;
  const path = suggestion.data;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Found <span className="font-mono text-xs">{path}</span> in your home folder.
        </span>
        <Button size="sm" onClick={() => save.run(path)} disabled={save.pending}>
          Use this folder
        </Button>
      </div>
      {save.error && <p className="text-destructive text-xs break-words">{save.error}</p>}
    </div>
  );
}

const PROJECTS_DIR = {
  label: "Full path to the projects folder",
  placeholder: "C:\\Users\\me\\Projects or /Users/me/Projects",
  configKey: "projectsDir",
};
