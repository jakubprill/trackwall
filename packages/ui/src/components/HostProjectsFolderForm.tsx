import { type FormEvent, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hostProjectsFolder, setHostProjectsFolder } from "@/lib/host-folder";
import { FILE_MANAGER } from "@/lib/platform";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * Where this computer sees the projects folder of a daemon in a container (ADR-131), so that "Show in Explorer" opens a
 * repo there. Tauri window only.
 */
export function HostProjectsFolderForm() {
  const load = useCallback(() => hostProjectsFolder(), []);
  const saved = useRemote(load);
  if (saved.error !== undefined) return <ErrorWithRetry message={saved.error} onRetry={saved.reload} />;
  if (saved.data === undefined) return <Loading />;
  return <FolderField key={saved.data ?? ""} saved={saved.data} onSaved={saved.reload} />;
}

function FolderField({ saved, onSaved }: { saved: string | null; onSaved: () => void }) {
  const [path, setPath] = useState(saved ?? "");
  const save = useAction(setHostProjectsFolder, onSaved);

  function submit(event: FormEvent) {
    event.preventDefault();
    save.run(path.trim() === "" ? null : path);
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">
        The projects folder of Trackwall in a container, as {FILE_MANAGER} on this computer reaches it, so "Show in {FILE_MANAGER}" opens a
        repo there. With a Docker volume on WSL it is in the volume's folder, for example{" "}
        <span className="font-mono break-all">\\wsl.localhost\rancher-desktop\var\lib\docker\volumes\workspace-repos\_data</span>.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Projects folder on this computer"
          className="font-mono text-xs"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          disabled={save.pending}
          spellCheck={false}
        />
        <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
          {path.trim() === "" && saved !== null ? "Forget" : "Save"}
        </Button>
      </div>
      {save.error && <p className="text-destructive text-xs break-words">{save.error}</p>}
    </form>
  );
}
