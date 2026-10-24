import { isTauri } from "@tauri-apps/api/core";
import { workspaceApi } from "@trackwall/protocol";
import { FolderOpen } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { pickFolder } from "@/lib/folder-picker";
import { useRemote } from "@/lib/use-remote";
import { RepoHostsForm } from "./RepoHostsForm.tsx";

/** Ustawienia workspace; każde z nich jest też kluczem w `workspace.yaml`, który można edytować ręcznie (ADR-13, ADR-18). */
export function SettingsView({ conn, onRetry, onSaved }: { conn: Connection; onRetry: () => void; onSaved: () => void }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

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
            <ProjectsDirForm
              conn={conn}
              initialPath={settings.data.projectsDir ?? ""}
              configFile={settings.data.configFile}
              onSaved={onSaved}
            />
          )}
          {/* Zły `projectsDir` wpisany ręcznie w `workspace.yaml` poprawia się właśnie tym formularzem. */}
          {settings.errorCode === "invalid_config" && <ProjectsDirForm conn={conn} initialPath="" onSaved={onSaved} />}
        </div>
      </Surface>
      <RepoHostsSurface conn={conn} />
    </div>
  );
}

/** Hostingi repo (ADR-19) mają własne zapytanie: zły wpis w `repoHosts` nie blokuje folderu z projektami i odwrotnie. */
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
        {/* Zły `repoHosts` wpisany ręcznie poprawia się, zapisując listę od nowa. */}
        {hosts.errorCode === "invalid_config" && <RepoHostsForm conn={conn} initial={[]} />}
      </div>
    </Surface>
  );
}

function ProjectsDirForm({
  conn,
  initialPath,
  configFile,
  onSaved,
}: {
  conn: Connection;
  initialPath: string;
  /** Nieznany, gdy `workspace.yaml` nie przeszedł walidacji. */
  configFile?: string;
  onSaved: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function save(dir: string) {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.setProjectsDir, { path: dir });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(path.trim());
  }

  /** Only the Tauri window has the system picker (ADR-51). A folder chosen in it is saved at once: choosing it already says what the user wants. */
  async function browse() {
    setError(undefined);
    let picked: string | undefined;
    try {
      picked = await pickFolder(path.trim());
    } catch (err) {
      return setError(errorMessage(err));
    }
    if (picked === undefined) return;
    setPath(picked);
    await save(picked);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\Users\me\Projects or /Users/me/Projects"
          aria-label="Full path to the projects folder"
          className="font-mono text-xs"
        />
        {isTauri() && (
          <Button type="button" variant="outline" size="sm" onClick={() => void browse()} disabled={busy}>
            <FolderOpen /> Choose…
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || path.trim() === ""}>
          Save
        </Button>
      </div>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
      <p className="text-muted-foreground text-xs break-all">
        {configFile ? (
          <>
            Saved as <span className="font-mono">projectsDir</span> in <span className="font-mono">{configFile}</span>
          </>
        ) : (
          "Fix the YAML syntax error in the file named above; saving here only fixes a bad projectsDir."
        )}
      </p>
    </form>
  );
}
