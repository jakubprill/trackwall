import { NO_MISE_TAG, type Repo, type RepoList, type RepoTag, workspaceApi } from "@trackwall/protocol";
import { FolderOpen, Plus, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime, twoDigits } from "@/lib/format";
import { branchLabel, listNeedsSettings, REPO_LIST_POLL_MS, repoStatusTone } from "@/lib/repo-status";
import { statusTextClass } from "@/lib/status-tone";
import { listSyncBadge, type SyncBadge, syncedByPath } from "@/lib/sync-state";
import { type BatchRunHandle, useBatchRun } from "@/lib/use-batch-run";
import { useRemote } from "@/lib/use-remote";
import { type SyncRunHandle, useSyncRun } from "@/lib/use-sync-run";
import { useTagFilter } from "@/lib/use-tag-filter";
import { cn } from "@/lib/utils";
import { BatchBar, BatchView } from "./BatchView.tsx";
import { CloneView } from "./CloneView.tsx";
import { RepoDetail } from "./RepoDetail.tsx";
import { SyncBar, SyncView } from "./SyncView.tsx";
import { TagFilter } from "./TagFilter.tsx";

/** Co pokazuje prawa strona: wybrane repo, wyszukiwarkę repo do sklonowania, synchronizację albo komendę zbiorczą. */
type Panel = "repo" | "clone" | "sync" | "batch";

export function ReposView({
  conn,
  initialRepo,
  onRetry,
  onOpenSettings,
}: {
  conn: Connection;
  /** Repo wybrane na starcie, np. otwarte z pulpitu w widoku „Home”. */
  initialRepo?: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const [selected, setSelected] = useState(initialRepo);
  const [panel, setPanel] = useState<Panel>("repo");
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const list = useRemote(load, { pollMs: REPO_LIST_POLL_MS });
  const sync = useSyncRun(conn, list.reload);
  const synced = syncedByPath(sync.run);
  const batch = useBatchRun(conn, list.reload);

  const needsSettings = listNeedsSettings(list.errorCode);
  const allRepos = needsSettings ? [] : (list.data?.repos ?? []);
  const filter = useTagFilter(conn, allRepos);
  const repos = filter.repos;
  const current = repos.find((r) => r.id === selected) ?? repos[0];
  const canSync = Boolean(list.data?.projectsDir) && !needsSettings;
  const syncedAgo = sync.run && relativeTime(sync.run.startedAt, new Date());

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">
            Repos {list.data && <span className="text-primary">{`// ${repoCount(repos.length, allRepos.length)}`}</span>}
          </h2>
          <span className="flex">
            <Button variant="ghost" size="icon" onClick={() => setPanel("clone")} aria-label="Add a repo from GitLab or GitHub">
              <Plus />
            </Button>
            <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Change the projects folder">
              <FolderOpen />
            </Button>
            <Button variant="ghost" size="icon" onClick={list.reload} aria-label="Refresh the repo list">
              <RefreshCw />
            </Button>
          </span>
        </div>
        {canSync && list.data?.projectsDir && (
          <FolderActions projectsDir={list.data.projectsDir} sync={sync} batch={batch} onShow={setPanel} />
        )}
        <TagFilter counts={filter.counts} selected={filter.selected} onToggle={filter.toggle} onClear={filter.clear} />
        <nav aria-label="Repo list" className="flex-1 overflow-y-auto px-2 pb-4">
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
          {list.data && !list.error && <EmptyList list={list.data} onOpenSettings={onOpenSettings} onClone={() => setPanel("clone")} />}
          <NoTagMatch shown={repos.length} all={allRepos.length} />
          {repos.map((repo, i) => (
            <RepoListItem
              key={repo.id}
              repo={repo}
              position={i + 1}
              syncBadge={syncedAgo ? listSyncBadge(synced.get(repo.path), syncedAgo) : undefined}
              tags={filter.tags.get(repo.id) ?? []}
              active={panel === "repo" && repo.id === current?.id}
              onSelect={() => {
                setSelected(repo.id);
                setPanel("repo");
              }}
            />
          ))}
        </nav>
      </aside>
      <section className="min-h-0 min-w-0 overflow-y-auto">
        {panel === "clone" && <CloneView conn={conn} onCloned={list.reload} onOpenSettings={onOpenSettings} />}
        {panel === "sync" && <SyncView sync={sync} canSync={canSync} />}
        {/* Nowy filtr tagów to nowa grupa repo: panel zaczyna od zaznaczenia wszystkich z niej. */}
        {panel === "batch" && <BatchView key={filter.selected.join(",")} batch={batch} repos={repos} />}
        {panel === "repo" && current && <RepoDetail key={current.id} conn={conn} repo={current} />}
        {/* Bez repo do pokazania lista po lewej mówi, co zrobić; tu zostaje tylko ładowanie. */}
        {!list.data && !list.error && <PanelLoading />}
      </section>
    </div>
  );
}

/** Filtr po tagach odrzucił wszystkie repo. */
function NoTagMatch({ shown, all }: { shown: number; all: number }) {
  if (shown > 0 || all === 0) return null;
  return <p className="text-muted-foreground px-2 text-sm">No repo has all the selected tags.</p>;
}

/** Liczba repo w nagłówku; przy filtrze po tagach także ile jest wszystkich. */
function repoCount(shown: number, all: number): string {
  return shown === all ? twoDigits(all) : `${twoDigits(shown)}/${twoDigits(all)}`;
}

/** Pod nagłówkiem listy: ścieżka folderu z projektami i akcje na wszystkich jego repo naraz. */
function FolderActions({
  projectsDir,
  sync,
  batch,
  onShow,
}: {
  projectsDir: string;
  sync: SyncRunHandle;
  batch: BatchRunHandle;
  onShow: (panel: Extract<Panel, "sync" | "batch">) => void;
}) {
  return (
    <>
      <p className="text-muted-foreground truncate px-4 pb-3 font-mono text-xs" title={projectsDir}>
        {projectsDir}
      </p>
      <SyncBar sync={sync} onShow={() => onShow("sync")} />
      <BatchBar batch={batch} onShow={() => onShow("batch")} />
    </>
  );
}

function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Loading />
    </div>
  );
}

/** Pusta lista ma dwa powody: folder z projektami nie jest ustawiony albo nie ma w nim repo gita. */
function EmptyList({ list, onOpenSettings, onClone }: { list: RepoList; onOpenSettings: () => void; onClone: () => void }) {
  if (list.projectsDir === null)
    return (
      <div className="flex flex-col items-start gap-2 px-2">
        <p className="text-muted-foreground text-sm">Choose your projects folder and Trackwall shows every git repo in it.</p>
        <ChangeProjectsDir onClick={onOpenSettings} />
      </div>
    );
  if (list.repos.length === 0)
    return (
      <div className="flex flex-col items-start gap-2 px-2">
        <p className="text-muted-foreground text-sm">The projects folder has no git repos. Clone one from GitLab or GitHub.</p>
        <Button variant="outline" size="sm" onClick={onClone}>
          <Plus /> Add repo
        </Button>
      </div>
    );
  return null;
}

function ChangeProjectsDir({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <FolderOpen /> Set projects folder
    </Button>
  );
}

/**
 * Wiersz listy w stylu HUD (ADR-16): numer pozycji, nazwa, gałąź oraz kropka i tekst stanu; aktywny ma świecącą kreskę z lewej.
 * Numer to tylko pozycja na liście, nie identyfikator repo. Pod stanem stoi wynik ostatniej synchronizacji (`listSyncBadge`)
 * i tagi repo (powody w podpowiedzi); tag `no-mise` jest napisem ostrzeżenia, bo w takim repo nie ma czego uruchomić (ADR-34).
 */
function RepoListItem({
  repo,
  position,
  syncBadge: badge,
  tags,
  active,
  onSelect,
}: {
  repo: Repo;
  position: number;
  syncBadge: SyncBadge | undefined;
  tags: RepoTag[];
  active: boolean;
  onSelect: () => void;
}) {
  const { status } = repo;
  const state = repoStatusTone(status);
  const noMise = tags.some((t) => t.name === NO_MISE_TAG);
  const otherTags = tags.filter((t) => t.name !== NO_MISE_TAG);
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
        {badge && (
          <span className="text-muted-foreground text-xs" title={badge.message}>
            <StatusLabel tone={badge.tone} label={badge.label} />
          </span>
        )}
        {tags.length > 0 && (
          <span className="text-muted-foreground text-2xs truncate font-mono" title={tags.map((t) => `#${t.name}: ${t.reason}`).join("\n")}>
            {noMise && <span className={cn(statusTextClass("warning"), "mr-2")}>no mise tasks</span>}
            {otherTags.map((t) => `#${t.name}`).join(" ")}
          </span>
        )}
      </span>
    </button>
  );
}
