import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { AppUpdateHandle } from "@/lib/use-app-update";
import { useRemote } from "@/lib/use-remote";
import { FolderForm } from "./FolderForm.tsx";
import { RepoHostsForm } from "./RepoHostsForm.tsx";
import { StartAtSignInSurface } from "./StartAtSignInSurface.tsx";
import { UpdatesSurface } from "./UpdatesSurface.tsx";

/** Workspace settings; each one is also a key in `workspace.yaml`, which can be edited by hand (ADR-13, ADR-18, ADR-84). */
export function SettingsView({
  conn,
  update,
  onRetry,
  onSaved,
}: {
  conn: Connection;
  update: AppUpdateHandle | undefined;
  onRetry: () => void;
  onSaved: () => void;
}) {
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
    <div className="flex w-full max-w-xl flex-col gap-4">
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
          {settings.data && (
            <FolderForm
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
      <RepoHostsSurface conn={conn} />
      <StartAtSignInSurface />
      <UpdatesSurface handle={update} />
    </div>
  );
}

const PROJECTS_DIR = {
  label: "Full path to the projects folder",
  placeholder: "C:\\Users\\me\\Projects or /Users/me/Projects",
  configKey: "projectsDir",
};

/** Repo hosts (ADR-19) have their own request: a bad `repoHosts` entry does not block the projects folder and vice versa. */
function RepoHostsSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.repoHosts, {}), [conn]);
  const hosts = useRemote(load);
  return (
    <Surface label="Repo hosts">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The Repos view searches these hosts and clones a repo into your projects folder in one click. Trackwall asks them through the glab
          (GitLab) and gh (GitHub) CLIs you are signed in to, so it never stores a token.
        </p>
        {hosts.error && <ErrorWithRetry message={hosts.error} onRetry={hosts.reload} />}
        {!hosts.data && !hosts.error && <Loading />}
        {hosts.data && <RepoHostsForm conn={conn} initial={hosts.data} />}
        {/* A bad `repoHosts` typed by hand is fixed by saving the list again. */}
        {hosts.errorCode === "invalid_config" && <RepoHostsForm conn={conn} initial={[]} />}
      </div>
    </Surface>
  );
}
