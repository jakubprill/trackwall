import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { type FormEvent, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/** Ustawienia workspace; każde z nich jest też kluczem w `workspace.yaml`, który można edytować ręcznie (ADR-13, ADR-18). */
export function SettingsView({ conn, onRetry, onSaved }: { conn: Connection; onRetry: () => void; onSaved: () => void }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

  return (
    <div className="w-full max-w-xl">
      <Surface label="Folder z projektami">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">
            Trackwall pokazuje w zakładce „Repo” każde repo gita, które leży bezpośrednio w tym folderze. Repo sklonowane do niego pojawi
            się na liście samo.
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
          {/* Także przy błędzie: zły `projectsDir` wpisany ręcznie w `workspace.yaml` poprawia się właśnie tym formularzem. */}
          {(settings.data || settings.error) && (
            <ProjectsDirForm key={settings.data ? "ustawienia" : "blad"} conn={conn} settings={settings.data} onSaved={onSaved} />
          )}
        </div>
      </Surface>
    </div>
  );
}

function ProjectsDirForm({ conn, settings, onSaved }: { conn: Connection; settings?: WorkspaceSettings; onSaved: () => void }) {
  const [path, setPath] = useState(settings?.projectsDir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.setProjectsDir, { path: path.trim() });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\Users\ja\Projects albo /Users/ja/Projects"
          aria-label="Pełna ścieżka do folderu z projektami"
          className="font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || path.trim() === ""}>
          Zapisz
        </Button>
      </div>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
      {settings && (
        <p className="text-muted-foreground text-xs break-all">
          Zapisane jako <span className="font-mono">projectsDir</span> w <span className="font-mono">{settings.configFile}</span>
        </p>
      )}
    </form>
  );
}
