import { type WorkBackupRestore, workBackupApi } from "@trackwall/protocol";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { post, uploadWorkBackup } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { restoreChanges, restoreFileLines, restoreRepoLines, restoreSummary } from "@/lib/work-backup";

/**
 * Restoring a work backup (ADR-275): the user picks a file a backup made, sees what restoring it would do repo by repo,
 * and restores it. A restore only adds what the repos lack, so "Look again" after cloning a missing repo and restoring
 * once more is safe.
 */
export function WorkRestorePanel({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workBackupApi.restorePlan, {}), [conn]);
  const plan = useRemote(load);
  const picker = useRef<HTMLInputElement>(null);
  const upload = useAction((file: File) => uploadWorkBackup(conn, file), plan.reload);
  const restore = useAction(() => post(conn, workBackupApi.restore, {}), plan.reload);
  const discard = useAction(() => post(conn, workBackupApi.discardRestore, {}), plan.reload);
  const busy = upload.pending || restore.pending || discard.pending;
  return (
    <div className="flex flex-col gap-3 border-t p-4">
      <p className="text-muted-foreground text-sm">
        Brings a backup back into the repos of this container. Clone the repos first; a restore only adds what they lack and never changes
        your own branches or files.
      </p>
      <input
        ref={picker}
        type="file"
        accept=".gz,application/gzip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload.run(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => picker.current?.click()}>
          {upload.pending ? "Reading the backup…" : "Restore from a backup…"}
        </Button>
      </div>
      {upload.error && <p className="text-destructive text-xs break-words">{upload.error}</p>}
      {plan.error && <p className="text-destructive text-xs break-words">{plan.error}</p>}
      {plan.data && (
        <RestorePlan
          plan={plan.data}
          busy={busy}
          restoring={restore.pending}
          onRestore={() => restore.run()}
          onLookAgain={plan.reload}
          onDiscard={() => discard.run()}
        />
      )}
      {restore.error && <p className="text-destructive text-xs break-words">{restore.error}</p>}
      {discard.error && <p className="text-destructive text-xs break-words">{discard.error}</p>}
    </div>
  );
}

function RestorePlan(props: {
  plan: WorkBackupRestore;
  busy: boolean;
  restoring: boolean;
  onRestore: () => void;
  onLookAgain: () => void;
  onDiscard: () => void;
}) {
  const { plan } = props;
  const files = restoreFileLines(plan.files);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Backup made {relativeTime(plan.createdAt, new Date())} by Trackwall {plan.version}: {restoreSummary(plan)}
      </p>
      {plan.repos.map((repo) => (
        <div key={repo.repo} className="flex flex-col gap-0.5">
          <p className="text-sm font-medium break-words">{repo.repo}</p>
          {restoreRepoLines(repo).map((line) => (
            <p key={line} className="text-muted-foreground text-xs break-words">
              {line}
            </p>
          ))}
        </div>
      ))}
      {files.map((line) => (
        <p key={line} className="text-muted-foreground text-xs break-words">
          {line}
        </p>
      ))}
      {plan.stateFilesKept > 0 && (
        <p className="text-muted-foreground text-xs">Your tasks and their journal stay in the file; a restore does not bring them back.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={props.busy || restoreChanges(plan) === 0} onClick={props.onRestore}>
          {props.restoring ? "Restoring…" : "Restore"}
        </Button>
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onLookAgain}>
          Look again
        </Button>
        <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}
