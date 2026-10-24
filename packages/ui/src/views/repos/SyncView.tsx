import type { SyncRepo } from "@trackwall/protocol";
import { FolderSync } from "lucide-react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { type SyncProgress, syncMessage, syncProgress, syncRepoTone } from "@/lib/sync-state";
import type { SyncRunHandle } from "@/lib/use-sync-run";

/**
 * Synchronizacja wszystkich repo (ADR-21): przycisk, postęp i wynik każdego repo z pełnym komunikatem, bo w wierszu
 * listy repo mieści się tylko krótki tekst.
 */
export function SyncView({ sync, canSync }: { sync: SyncRunHandle; canSync: boolean }) {
  const { run } = sync;
  const progress = run ? syncProgress(run) : undefined;
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="hud-label">Sync</span>
          <h1 className="text-xl font-semibold tracking-tight">All repos in the folder</h1>
          <p className="text-muted-foreground max-w-prose text-sm">
            Fetches every repo and moves the default branch to the remote one when that is a clean fast-forward. A repo with changes on the
            default branch, or with a diverged or unpushed branch, is left untouched.
          </p>
        </div>
        <SyncButton sync={sync} canSync={canSync} />
      </header>
      {sync.error && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{sync.error}</p>}
      {run === undefined && !sync.error && <Loading />}
      {run === null && <p className="text-muted-foreground text-sm">This folder has not been synced since the daemon started.</p>}
      {run && progress && (
        <Surface
          label={run.finishedAt === null ? "Running" : `Finished ${relativeTime(run.finishedAt, new Date())}`}
          meta={`${progress.done}/${progress.total}`}
          note={summary(progress)}
        >
          {run.repos.length === 0 && <p className="text-muted-foreground p-3 text-sm">The projects folder had no repos.</p>}
          <ul className="divide-y">
            {run.repos.map((repo) => (
              <SyncRow key={repo.path} repo={repo} />
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}

/** Pod ścieżką folderu na liście repo: start synchronizacji i przejście do jej wyników; start od razu je pokazuje. */
export function SyncBar({ sync, onShow }: { sync: SyncRunHandle; onShow: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <SyncButton sync={sync} canSync onStart={onShow} />
      {sync.run && (
        <Button variant="ghost" size="sm" onClick={onShow}>
          Results
        </Button>
      )}
    </div>
  );
}

function SyncButton({ sync, canSync, onStart }: { sync: SyncRunHandle; canSync: boolean; onStart?: () => void }) {
  const progress = sync.run && sync.running ? syncProgress(sync.run) : undefined;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={sync.running || !canSync}
      onClick={() => {
        sync.start();
        onStart?.();
      }}
    >
      <FolderSync /> {progress ? `Syncing ${progress.done}/${progress.total}` : "Sync all"}
    </Button>
  );
}

function summary(p: SyncProgress): string | undefined {
  if (p.updated + p.skipped + p.failed === 0) return undefined;
  return `Updated: ${p.updated} · skipped: ${p.skipped} · failed: ${p.failed}`;
}

function SyncRow({ repo }: { repo: SyncRepo }) {
  const { tone, label } = syncRepoTone(repo);
  const message = syncMessage(repo);
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-sm" title={repo.path}>
          {repo.repo}
        </span>
        {message && (
          <span
            className={
              repo.state === "failed" ? "text-destructive text-xs whitespace-pre-wrap break-words" : "text-muted-foreground text-xs"
            }
          >
            {message}
          </span>
        )}
      </div>
      <span className="shrink-0 pt-0.5 text-xs">
        <StatusLabel tone={tone} label={label} />
      </span>
    </li>
  );
}
