import { WORK_BACKUP_DOWNLOAD_PATH, type WorkBackupInfo, workBackupApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { download, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { saveFile } from "@/lib/folder-files";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { workBackupContents, workBackupWhen } from "@/lib/work-backup";

/**
 * The work backup (ADR-275): in a container, one file with the commits, stashes and uncommitted changes that exist only
 * in its volume, and Trackwall's own files. The user makes it here and saves it on their computer, where the agents in
 * the container cannot reach it; the file in the container holds only the last one.
 */
export function WorkBackupSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workBackupApi.state, {}), [conn]);
  const state = useRemote(load);
  const create = useAction(() => post(conn, workBackupApi.create, {}), state.reload);
  const save = useAction(
    async (info: WorkBackupInfo) => saveFile(await download(conn, WORK_BACKUP_DOWNLOAD_PATH, {}), info.fileName),
    () => {},
  );
  if (state.error) return <ErrorWithRetry message={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  if (!state.data.inContainer)
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Only where Trackwall runs in a dev container: there your repos live in a Docker volume, which removing it or resetting Docker
        deletes with every commit you have not pushed. Here they are on this computer's own disk.
      </p>
    );
  const last = state.data.last;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-muted-foreground text-sm">
        Puts what only this container has into one file: commits on no remote, stashes and uncommitted changes of every repo and task, with
        your tasks, board, knowledge, routines and templates. Files git ignores, such as .env, and sign-ins stay out. Download the file to
        keep it on your computer; Trackwall keeps only the last one in the container.
      </p>
      {last ? <LastBackup info={last} /> : <p className="text-sm">No backup yet.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={create.pending || state.data.running} onClick={() => create.run()}>
          {create.pending || state.data.running ? "Backing up…" : "Back up now"}
        </Button>
        {last && (
          <Button variant="outline" size="sm" disabled={save.pending} onClick={() => save.run(last)}>
            Download backup
          </Button>
        )}
      </div>
      {create.error && <p className="text-destructive text-xs">{create.error}</p>}
      {save.error && <p className="text-destructive text-xs">{save.error}</p>}
    </div>
  );
}

function LastBackup({ info }: { info: WorkBackupInfo }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">{workBackupWhen(info, new Date())}</p>
      <p className="text-muted-foreground text-xs">{workBackupContents(info)}</p>
      {info.skipped.map((s) => (
        <p key={s.repo} className="text-warning text-xs break-words">
          Not in the backup: {s.repo}, {s.message}
        </p>
      ))}
    </div>
  );
}
