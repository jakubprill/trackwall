import { type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DaemonPlaceContext } from "@/lib/desktop";
import {
  cancelDevContainerStart,
  DEFAULT_FOLDER_TO_OPEN,
  type DevContainer,
  devContainerStarting,
  type OtherVersion,
  savedDevContainer,
  setDevContainer,
  startDevContainer,
  updateDevContainer,
} from "@/lib/dev-container";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The dev container the app starts itself (ADR-139): saved once, then "Start" opens VS Code on it and connects to
 * Trackwall inside. Tauri window only.
 */
export function DevContainerForm() {
  const load = useCallback(() => savedDevContainer(), []);
  const saved = useRemote(load);
  // A daemon in a dev container that names its folder (ADR-121) fills it in.
  const reported = useContext(DaemonPlaceContext).devContainerFolder;
  if (saved.error !== undefined) return <ErrorWithRetry message={saved.error} onRetry={saved.reload} />;
  if (saved.data === undefined) return <Loading />;
  const initial = saved.data ?? { folder: reported ?? "", open: DEFAULT_FOLDER_TO_OPEN };
  return (
    <div className="flex flex-col gap-2">
      <DevContainerFields key={JSON.stringify(saved.data)} saved={saved.data} initial={initial} onSaved={saved.reload} />
      {saved.data && <StartButton />}
    </div>
  );
}

function DevContainerFields({ saved, initial, onSaved }: { saved: DevContainer | null; initial: DevContainer; onSaved: () => void }) {
  const [folder, setFolder] = useState(initial.folder);
  const [open, setOpen] = useState(initial.open);
  const save = useAction(setDevContainer, onSaved);
  const forgetting = folder.trim() === "" && saved !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    save.run(folder.trim() === "" ? null : { folder, open });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">
        To let the app start Trackwall's dev container like your own shortcut does, enter the folder on this computer that holds its{" "}
        <span className="font-mono">.devcontainer</span> and the folder VS Code opens inside it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Dev container folder on this computer"
          placeholder="C:\Users\me\Dev\workspace"
          className="min-w-64 flex-1 font-mono text-xs"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          disabled={save.pending}
          spellCheck={false}
        />
        <Input
          aria-label="Folder to open in the container"
          className="w-40 font-mono text-xs"
          value={open}
          onChange={(e) => setOpen(e.target.value)}
          disabled={save.pending}
          spellCheck={false}
        />
        <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
          {forgetting ? "Forget" : "Save"}
        </Button>
      </div>
      {save.error && <p className="text-destructive text-xs break-words">{save.error}</p>}
    </form>
  );
}

/** How often the form asks whether a start, perhaps one it did not begin, is still waiting, and whether one began elsewhere. */
const STARTING_POLL_MS = 2000;
const IDLE_POLL_MS = 10_000;

/** Nothing follows in this window: the app restarts. */
const RESTARTS = () => {};

/**
 * "Start" and, while a start waits, "Cancel": VS Code may fail in a window the user does not watch, and a start this
 * window did not begin (before a reload, or in another window) shows the same way, so the user never waits out the time
 * limit for lack of a way out.
 */
function StartButton() {
  const [otherVersion, setOtherVersion] = useState<OtherVersion | null>(null);
  const start = useAction(startDevContainer, setOtherVersion);
  const update = useAction(updateDevContainer, RESTARTS);
  // Asked often only while a start waits, which a cancel ends after the Docker call in progress.
  const starting = useRemote(devContainerStarting, { pollMs: (running) => (running ? STARTING_POLL_MS : IDLE_POLL_MS) });
  const cancel = useAction(cancelDevContainerStart, starting.reload);
  const reloadStarting = starting.reload;
  useEffect(() => {
    if (start.error !== undefined || update.error !== undefined) reloadStarting();
  }, [reloadStarting, start.error, update.error]);
  const waiting = start.pending || update.pending || starting.data === true;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={waiting}
          onClick={() => {
            setOtherVersion(null);
            start.run();
          }}
        >
          {waiting && !update.pending ? "Starting…" : "Start the dev container and connect"}
        </Button>
        {otherVersion && (
          <Button size="sm" variant="outline" disabled={waiting} onClick={() => update.run()}>
            {update.pending ? "Updating…" : `Update Trackwall in the container to ${otherVersion.app}`}
          </Button>
        )}
        {waiting && (
          <Button size="sm" variant="outline" disabled={cancel.pending} onClick={() => cancel.run()}>
            Cancel
          </Button>
        )}
      </div>
      {waiting && !update.pending && (
        <p className="text-muted-foreground text-xs">
          VS Code opens the dev container; the first start builds it and can take a few minutes. The app restarts once Trackwall in it
          answers.
        </p>
      )}
      {otherVersion && !update.pending && (
        <p className="text-muted-foreground text-xs">
          Trackwall in the container is {otherVersion.container}, but this app is {otherVersion.app}. Update it in the container, or update
          this app if the container is newer.
        </p>
      )}
      {update.pending && (
        <p className="text-muted-foreground text-xs">
          Trackwall in the container downloads {otherVersion?.app}, checks its signature and restarts; this takes a few minutes. The app
          restarts once it answers.
        </p>
      )}
      {start.error && <p className="text-destructive text-xs break-words">{start.error}</p>}
      {update.error && <p className="text-destructive text-xs break-words">{update.error}</p>}
    </div>
  );
}
