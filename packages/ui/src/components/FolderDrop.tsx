import { workspaceApi } from "@trackwall/protocol";
import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type DropPrompt, dropOutcome, extraItemsNote } from "@/lib/dropped-folder";
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
  /** At least one full path; a new drop mounts a new bar (`key`), so the paths do not change while it is shown. */
  paths: readonly string[];
  onOpenRepos: (repo?: string) => void;
  onDismiss: () => void;
}) {
  const [checked, setChecked] = useState<{ prompt?: DropPrompt; error?: string }>({});
  const openRepos = useRef(onOpenRepos);
  openRepos.current = onOpenRepos;
  const [first = ""] = paths;
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
        if (outcome.kind === "open-repos") openRepos.current(outcome.repo);
        else setChecked({ prompt: outcome });
      },
      (err: unknown) => current && setChecked({ error: errorMessage(err) }),
    );
    return () => {
      current = false;
    };
  }, [conn, first]);

  const { prompt, error } = checked;
  const note = extraItemsNote(paths);
  return (
    <div className="bg-card flex flex-wrap items-center gap-3 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {!prompt && !error && <Loading text="Checking the dropped folder…" />}
        {error && <p className="text-destructive text-sm break-words">{error}</p>}
        {prompt && <p className="text-sm break-words">{prompt.message}</p>}
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
        {setProjectsDir.error && <p className="text-destructive text-xs break-words">{setProjectsDir.error}</p>}
      </div>
      {prompt?.projectsDir && (
        <Button
          size="sm"
          onClick={() => prompt.projectsDir && setProjectsDir.run(prompt.projectsDir.path)}
          disabled={setProjectsDir.pending}
        >
          {prompt.projectsDir.label}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
