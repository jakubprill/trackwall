import { workspaceApi } from "@trackwall/protocol";
import { useEffect, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type DropPrompt, dropOutcome, extraItemsNote } from "@/lib/dropped-folder";
import type { DroppedPaths } from "@/lib/file-drop";
import { useAction } from "@/lib/use-action";

/**
 * The bar under the window's top edge after a drop outside a session (ADR-51): asks the daemon what the first dropped
 * item is, opens a listed repo right away and otherwise says what it is, offering the projects folder change when it
 * has repos. The change itself is `set-projects-dir`, the same as in Settings.
 */
export function FolderDrop({
  conn,
  paths,
  onOpenRepos,
  onDismiss,
}: {
  conn: Connection;
  /** A new drop mounts a new bar (`key`), so the paths do not change while it is shown. */
  paths: DroppedPaths;
  /** Stable between renders: the check runs once per bar. */
  onOpenRepos: (repo?: string) => void;
  onDismiss: () => void;
}) {
  const [checked, setChecked] = useState<Checked>({ kind: "checking" });
  const [first] = paths;
  const setProjectsDir = useAction(
    (path: string) => post(conn, workspaceApi.setProjectsDir, { path }),
    () => onOpenRepos(),
  );

  useEffect(() => {
    let current = true;
    post(conn, workspaceApi.droppedFolder, { path: first }).then(
      (folder) => {
        if (!current) return;
        const outcome = dropOutcome(folder);
        if (outcome.kind === "open-repos") onOpenRepos(outcome.repo);
        else setChecked(outcome);
      },
      (err: unknown) => current && setChecked({ kind: "error", message: errorMessage(err) }),
    );
    return () => {
      current = false;
    };
  }, [conn, first, onOpenRepos]);

  const offer = checked.kind === "prompt" ? checked.projectsDir : undefined;
  const note = extraItemsNote(paths);
  return (
    <div className="bg-card flex flex-wrap items-center gap-3 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {checked.kind === "checking" && <Loading text="Checking the dropped folder…" />}
        {checked.kind === "error" && <p className="text-destructive text-sm break-words">{checked.message}</p>}
        {checked.kind === "prompt" && <p className="text-sm break-words">{checked.message}</p>}
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
        {setProjectsDir.error && <p className="text-destructive text-xs break-words">{setProjectsDir.error}</p>}
      </div>
      {offer && (
        <Button size="sm" onClick={() => setProjectsDir.run(offer.path)} disabled={setProjectsDir.pending}>
          {offer.label}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

type Checked = { kind: "checking" } | { kind: "error"; message: string } | DropPrompt;
