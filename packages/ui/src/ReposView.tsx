import { type Repo, type RepoList, workspaceApi } from "@trackwall/protocol";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { twoDigits } from "@/lib/format";
import { branchLabel, repoStatusTone } from "@/lib/repo-status";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { RepoDetail } from "./RepoDetail.tsx";

/** Lista repo i ich stan pochodzą z folderu z projektami i z gita przy każdym zapytaniu (§4.5), więc lista jest odpytywana cyklicznie. */
const POLL_MS = 10_000;

export function ReposView({ conn, onRetry, onOpenSettings }: { conn: Connection; onRetry: () => void; onOpenSettings: () => void }) {
  const [selected, setSelected] = useState<string>();
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const list = useRemote(load, { pollMs: POLL_MS });

  // Folder z projektami, który zniknął albo jest źle wpisany w `workspace.yaml`, poprawia się w ustawieniach,
  // a stara lista wyglądałaby na aktualną.
  const needsSettings = list.errorCode === "projects_dir_unavailable" || list.errorCode === "invalid_config";
  const repos = needsSettings ? [] : (list.data?.repos ?? []);
  const current = repos.find((r) => r.id === selected) ?? repos[0];

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">Repo {list.data && <span className="text-primary">{`// ${twoDigits(repos.length)}`}</span>}</h2>
          <span className="flex">
            <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Zmień folder z projektami">
              <FolderOpen />
            </Button>
            <Button variant="ghost" size="icon" onClick={list.reload} aria-label="Odśwież listę repo">
              <RefreshCw />
            </Button>
          </span>
        </div>
        {list.data?.projectsDir && (
          <p className="text-muted-foreground truncate px-4 pb-3 font-mono text-xs" title={list.data.projectsDir}>
            {list.data.projectsDir}
          </p>
        )}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {list.error && (
            <div className="px-2 pb-2">
              <ErrorWithRetry
                message={list.error}
                onRetry={() => {
                  onRetry();
                  list.reload();
                }}
              >
                {needsSettings && <ChangeProjectsDir onClick={onOpenSettings} />}
              </ErrorWithRetry>
            </div>
          )}
          {list.data && !list.error && <EmptyList list={list.data} onOpenSettings={onOpenSettings} />}
          {repos.map((repo, i) => (
            <RepoListItem
              key={repo.id}
              repo={repo}
              position={i + 1}
              active={repo.id === current?.id}
              onSelect={() => setSelected(repo.id)}
            />
          ))}
        </nav>
      </aside>
      <section className="min-h-0 min-w-0 overflow-y-auto">
        {current && <RepoDetail key={current.id} conn={conn} repo={current} />}
        {/* Bez repo do pokazania lista po lewej mówi, co zrobić; tu zostaje tylko ładowanie. */}
        {!list.data && !list.error && (
          <div className="flex h-full items-center justify-center p-6">
            <Loading />
          </div>
        )}
      </section>
    </div>
  );
}

/** Pusta lista ma dwa powody: folder z projektami nie jest ustawiony albo nie ma w nim repo gita. */
function EmptyList({ list, onOpenSettings }: { list: RepoList; onOpenSettings: () => void }) {
  if (list.projectsDir === null)
    return (
      <div className="flex flex-col items-start gap-2 px-2">
        <p className="text-muted-foreground text-sm">
          Wskaż folder z projektami, a Trackwall pokaże wszystkie repo gita, które w nim leżą.
        </p>
        <ChangeProjectsDir onClick={onOpenSettings} />
      </div>
    );
  if (list.repos.length === 0)
    return (
      <p className="text-muted-foreground px-2 text-sm">
        W folderze z projektami nie ma repo gita. Sklonuj do niego repo albo wskaż inny folder z projektami.
      </p>
    );
  return null;
}

function ChangeProjectsDir({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <FolderOpen /> Ustaw folder z projektami
    </Button>
  );
}

/**
 * Wiersz listy w stylu HUD (ADR-16): numer pozycji, nazwa, gałąź oraz kropka i tekst stanu; aktywny ma świecącą kreskę z lewej.
 * Numer to tylko pozycja na liście, nie identyfikator repo.
 */
function RepoListItem({ repo, position, active, onSelect }: { repo: Repo; position: number; active: boolean; onSelect: () => void }) {
  const { status } = repo;
  const state = repoStatusTone(status);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <span className="text-muted-foreground text-2xs w-5 shrink-0 pt-0.5 text-right font-mono">{twoDigits(position)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">{repo.id}</span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          {status.kind === "ok" && <span className="min-w-0 truncate font-mono">{branchLabel(status)}</span>}
          <StatusLabel tone={state.tone} label={state.label} />
        </span>
      </span>
    </button>
  );
}
