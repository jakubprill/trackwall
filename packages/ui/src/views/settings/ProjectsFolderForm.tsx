import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useDesktop } from "@/lib/desktop";
import { daemonExamplePaths } from "@/lib/platform";
import { useAction } from "@/lib/use-action";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

const PROJECTS_DIR = {
  label: "Full path to the projects folder",
  configKey: "projectsDir",
};

/**
 * The projects folder (ADR-18) as a form: a folder Trackwall found, offered with one button while none is set, and the
 * path to type or choose. "Settings > Workspace" and the first step of "Get started" (ADR-262) show the same form.
 */
export function ProjectsFolderForm({
  conn,
  settings,
  onSaved,
  onRetry,
}: {
  conn: Connection;
  settings: RemoteHandle<WorkspaceSettings>;
  /** After the folder is saved and the settings are asked for again. */
  onSaved: () => void;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
}) {
  const example = daemonExamplePaths(useDesktop()).projectsDir;
  async function save(path: string) {
    await post(conn, workspaceApi.setProjectsDir, { path });
    settings.reload();
    onSaved();
  }
  return (
    <>
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
      {settings.data?.projectsDir === null && <SuggestedProjectsDir conn={conn} use={save} />}
      {settings.data && (
        <PathForm
          key={settings.data.projectsDir ?? ""}
          {...PROJECTS_DIR}
          placeholder={example}
          initialPath={settings.data.projectsDir ?? ""}
          configFile={settings.data.configFile}
          save={save}
        />
      )}
      {/* A bad `projectsDir` typed by hand into `workspace.yaml` is fixed with this very form. */}
      {settings.errorCode === "invalid_config" && <PathForm {...PROJECTS_DIR} placeholder={example} initialPath="" save={save} />}
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
