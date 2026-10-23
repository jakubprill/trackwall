import type { SyncRepo } from "@trackwall/protocol";
import { FolderSync } from "lucide-react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { type SyncProgress, syncProgress, syncRepoTone } from "@/lib/sync-state";
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
          <span className="hud-label">Synchronizacja</span>
          <h1 className="text-xl font-semibold tracking-tight">Wszystkie repo z folderu</h1>
          <p className="text-muted-foreground max-w-prose text-sm">
            Fetch każdego repo i przesunięcie gałęzi domyślnej do zdalnej, jeśli to czysty fast-forward. Repo ze zmianami w gałęzi
            domyślnej, z rozjechaną albo niewypchniętą gałęzią zostaje nietknięte.
          </p>
        </div>
        <SyncButton sync={sync} canSync={canSync} />
      </header>
      {sync.error && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{sync.error}</p>}
      {run === undefined && !sync.error && <Loading />}
      {run === null && <p className="text-muted-foreground text-sm">Od startu daemona nie było synchronizacji tego folderu.</p>}
      {run && progress && (
        <Surface
          label={run.finishedAt === null ? "Trwa" : `Zakończona ${relativeTime(run.finishedAt, new Date())}`}
          meta={`${progress.done}/${progress.total}`}
          note={summary(progress)}
        >
          {run.repos.length === 0 && <p className="text-muted-foreground p-3 text-sm">W folderze z projektami nie było repo.</p>}
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
          Wyniki
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
      <FolderSync /> {progress ? `Synchronizuję ${progress.done}/${progress.total}` : "Synchronizuj wszystko"}
    </Button>
  );
}

function summary(p: SyncProgress): string | undefined {
  if (p.updated + p.skipped + p.failed === 0) return undefined;
  return `Przesunięte: ${p.updated} · pominięte: ${p.skipped} · błędy: ${p.failed}`;
}

function SyncRow({ repo }: { repo: SyncRepo }) {
  const { tone, label } = syncRepoTone(repo);
  const message = repo.state === "skipped" || repo.state === "failed" ? repo.message : undefined;
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
