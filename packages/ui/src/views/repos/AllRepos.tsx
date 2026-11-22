import type { RunningMiseTask, SessionList } from "@trackwall/protocol";
import { ArrowRight, ChevronDown, ChevronRight, FolderGit2, HardDrive } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { type AllReposRow, allReposSummary, fetchedLine, foldedLine, needsLook, splitRows } from "@/lib/all-repos";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { type RepoActivityItem, type RepoActivityTarget, repoActivity } from "@/lib/repo-activity";
import type { RepoTab } from "@/lib/repo-tabs";
import type { SessionSelection } from "@/lib/session-entries";
import { UNPUSHED_NOTE } from "@/lib/unpushed-work";
import { pullResultLine, workInRepoFolder } from "@/lib/upstream-pull";
import { type PullHandle, type PullState, usePull } from "@/lib/use-pull";
import { useRunningMiseTasks } from "@/lib/use-running-mise-tasks";
import type { SyncRunHandle } from "@/lib/use-sync-run";
import { cn } from "@/lib/utils";
import { PullButton, PullFailure, PullQuestion } from "./PullControls.tsx";
import { SyncButton } from "./SyncView.tsx";

/**
 * "All repos" (ADR-293): the first entry of the repo list and the panel the "Repos" view opens on, with every repo's
 * state against the server in one table (`lib/all-repos.ts`) and "Sync all" above it. A wide panel has a column for each
 * part of the state; a narrow one, such as beside the pinned supervisor, stacks them in one.
 */

/** What a sync does, under the panel's heading, since its button now stands here. */
const SYNC_NOTE =
  "Sync all fetches every repo and moves each default branch forward when nothing is in its way; it never touches your changes.";

/** Above the repos of the list: All repos, with the state of all of them in one line; nothing while the list is empty. */
export function AllReposEntry({ rows, active, onSelect }: { rows: readonly AllReposRow[]; active: boolean; onSelect: () => void }) {
  if (rows.length === 0) return null;
  const summary = allReposSummary(rows);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "mb-1 flex w-full items-start gap-3 rounded-md border border-transparent p-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <span className="flex w-5 shrink-0 justify-end pt-0.5">
        <FolderGit2 className="text-primary size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">All repos</span>
        <span className="flex min-w-0 text-xs" title={summary.title}>
          <StatusLabel tone={summary.tone} label={summary.label} labelClassName="truncate" className="min-w-0 shrink" />
        </span>
      </span>
    </button>
  );
}

interface AllReposProps {
  conn: Connection;
  rows: readonly AllReposRow[];
  /** The daemon runs in a container: work on no remote gets its own column (ADR-162). */
  inContainer: boolean;
  /** How many repos the tag filter left of all (ADR-25); the table shows only those. */
  filter: { shown: number; all: number };
  /** `undefined` until the first session list arrives. */
  sessions: SessionList | undefined;
  sync: SyncRunHandle;
  canSync: boolean;
  onShowSync: () => void;
  /** Opens a repo, on `tab` when given (the way out of a row), else as from the list. */
  onOpenRepo: (repo: string, tab?: RepoTab) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}

/** The panel with the running mise tasks, which say what goes on in each repo and what a pull would change files under. */
export function AllReposPanel({ runningLive, ...props }: AllReposProps & { runningLive: LiveFeed<RunningMiseTask[]> | undefined }) {
  const running = useRunningMiseTasks(props.conn, runningLive).data ?? [];
  return <AllReposView {...props} running={running} />;
}

export function AllReposView({
  conn,
  rows,
  inContainer,
  filter,
  sessions,
  running,
  sync,
  canSync,
  onShowSync,
  onOpenRepo,
  onOpenInSessions,
  initialPulls,
}: AllReposProps & {
  running: readonly RunningMiseTask[];
  /** The state a row's pull starts in, by repo, for the gallery of view states; in the app no pull has started. */
  initialPulls?: Readonly<Record<string, PullState>>;
}) {
  const kept = useKept(rows);
  const [showFolded, setShowFolded] = useState(false);
  const { shown, folded } = splitRows(rows, kept);
  const visible = showFolded ? rows : shown;
  const line = foldedLine(folded, shown.length);
  const fetched = fetchedLine(rows, new Date());
  const openActivity = (repo: string, target: RepoActivityTarget) =>
    target.view === "mise" ? onOpenRepo(repo, "mise") : onOpenInSessions(target.selection);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="hud-label">All repos</span>
          <h1 className="text-xl font-semibold tracking-tight">The state of every repo</h1>
          {fetched && <p className="text-muted-foreground text-sm">{fetched}</p>}
          <p className="text-muted-foreground max-w-prose text-sm">{SYNC_NOTE}</p>
          {filter.shown < filter.all && (
            <p className="text-muted-foreground text-sm">{`The ${filter.shown} of ${filter.all} repos with the selected tags.`}</p>
          )}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {sync.run && (
            <Button variant="ghost" size="sm" onClick={onShowSync}>
              Results
            </Button>
          )}
          <SyncButton sync={sync} canSync={canSync} />
        </span>
      </header>
      {sync.error && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{sync.error}</p>}
      {rows.some((r) => r.onlyHere !== null) && (
        <p className="text-muted-foreground flex items-start gap-2 text-xs">
          <HardDrive className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>Only in this container: {UNPUSHED_NOTE}</span>
        </p>
      )}
      <section aria-label="The state of every repo" className="surface @container min-w-0 overflow-hidden">
        {visible.length > 0 && (
          <table className="w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b">
                <Head>Repo</Head>
                <Head className={NARROW}>State</Head>
                <Head className={WIDE}>Your changes</Head>
                <Head className={WIDE}>From the server</Head>
                {inContainer && <Head className={WIDE}>Only in this container</Head>}
                <Head className={WIDE}>Now</Head>
                <Head className={cn(WIDE, "w-32")}>
                  <span className="sr-only">Next step</span>
                </Head>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <TableRow
                  key={row.repo}
                  conn={conn}
                  row={row}
                  inContainer={inContainer}
                  activity={repoActivity(row.repo, sessions, running)}
                  workInFolder={workInRepoFolder(row.repo, sessions, running)}
                  onOpenRepo={(tab) => onOpenRepo(row.repo, tab)}
                  onOpenActivity={(target) => openActivity(row.repo, target)}
                  initialPull={initialPulls?.[row.repo]}
                />
              ))}
            </tbody>
          </table>
        )}
        {line && (
          <button
            type="button"
            aria-expanded={showFolded}
            onClick={() => setShowFolded(!showFolded)}
            className={cn(
              "text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
              visible.length > 0 && "border-t",
            )}
          >
            {showFolded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            <span className="min-w-0 truncate">{line}</span>
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * The repos that needed a look at any time while the panel is open (`splitRows`): it grows after the render that shows
 * a new one, so a row that needs a look shows at once and stays after it turns clean.
 */
function useKept(rows: readonly AllReposRow[]): ReadonlySet<string> {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const fresh = rows.filter((r) => needsLook(r) && !kept.has(r.repo)).map((r) => r.repo);
    if (fresh.length > 0) setKept(new Set([...kept, ...fresh]));
  }, [rows, kept]);
  return kept;
}

/**
 * The columns a wide panel shows, each part of the state and the next step on its own, and the one a narrow panel
 * stacks them in, the next step last.
 */
const WIDE = "hidden @3xl:table-cell";
const NARROW = "@3xl:hidden";
const CELL = "min-w-0 px-3 py-2 align-middle";

function Head({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <th scope="col" className={cn("hud-label px-3 py-2 align-bottom font-normal", className)}>
      {children}
    </th>
  );
}

function TableRow({
  conn,
  row,
  inContainer,
  activity,
  workInFolder,
  onOpenRepo,
  onOpenActivity,
  initialPull,
}: {
  conn: Connection;
  row: AllReposRow;
  inContainer: boolean;
  activity: readonly RepoActivityItem[];
  workInFolder: readonly string[];
  onOpenRepo: (tab?: RepoTab) => void;
  onOpenActivity: (target: RepoActivityTarget) => void;
  initialPull: PullState | undefined;
}) {
  const pull = usePull(conn, row.repo, workInFolder, initialPull);
  const { state } = pull;
  const detail = state.kind === "asking" || state.kind === "failed";
  const ok = row.kind === "ok" ? row : undefined;
  return (
    <>
      <tr className={cn("border-b last:border-b-0", detail && "border-b-0")}>
        <td className={CELL}>
          <button
            type="button"
            className="hover:text-primary block max-w-full truncate text-left font-medium"
            title={`Open ${row.repo}`}
            onClick={() => onOpenRepo()}
          >
            {row.repo}
          </button>
          <RepoLine row={row} />
        </td>
        <td className={cn(CELL, NARROW)}>
          <span className="flex min-w-0 flex-col gap-1 text-xs">
            {ok?.changes && <Part label={ok.changes} />}
            {ok?.server && <Part label={ok.server} title={ok.serverTitle} />}
            {row.onlyHere && <Part label={`${row.onlyHere.label} only here`} title={row.onlyHere.detail} />}
            <Activity items={activity} onOpen={onOpenActivity} empty={null} />
            <span className="flex min-w-0">
              <RowAction row={row} pull={pull} onOpenRepo={onOpenRepo} />
            </span>
          </span>
        </td>
        <td className={cn(CELL, WIDE)}>{ok?.changes ? <Part label={ok.changes} /> : <None />}</td>
        <td className={cn(CELL, WIDE)} title={ok?.serverTitle}>
          {ok?.server ? <Part label={ok.server} title={ok.serverTitle} /> : <None />}
        </td>
        {inContainer && (
          <td className={cn(CELL, WIDE)}>{row.onlyHere ? <Part label={row.onlyHere.label} title={row.onlyHere.detail} /> : <None />}</td>
        )}
        <td className={cn(CELL, WIDE)}>
          <Activity items={activity} onOpen={onOpenActivity} empty={<None />} />
        </td>
        <td className={cn(CELL, WIDE)}>
          <span className="flex min-w-0 justify-end">
            <RowAction row={row} pull={pull} onOpenRepo={onOpenRepo} />
          </span>
        </td>
      </tr>
      {detail && (
        <DetailRow inContainer={inContainer}>
          {state.kind === "asking" ? (
            <PullQuestion workInFolder={workInFolder} pull={pull} />
          ) : (
            <PullFailure message={state.message} pull={pull} />
          )}
        </DetailRow>
      )}
    </>
  );
}

/**
 * A line under a row across the whole table, for the pull's question or failure. Its cell in each layout spans exactly
 * the columns that layout shows: the repo's and State, or the repo's and the wide ones. A cell spanning more would add
 * empty columns to the table, which squeeze the others and push a narrow table out of its frame.
 */
function DetailRow({ inContainer, children }: { inContainer: boolean; children: ReactNode }) {
  return (
    <tr className="border-b last:border-b-0">
      <td colSpan={2} className={cn("px-3 pb-3", NARROW)}>
        {children}
      </td>
      <td colSpan={inContainer ? 6 : 5} className={cn("px-3 pb-3", WIDE)}>
        {children}
      </td>
    </tr>
  );
}

/** Under the repo's name: its branch, or that git cannot read it or has not yet. */
function RepoLine({ row }: { row: AllReposRow }) {
  if (row.kind === "ok") return <span className="text-muted-foreground block truncate font-mono text-xs">{row.branch}</span>;
  if (row.kind === "loading") return <span className="text-muted-foreground block text-xs">loading</span>;
  return (
    <span className="flex min-w-0 text-xs" title={row.message}>
      <StatusLabel tone="error" label="unavailable" labelClassName="truncate" className="min-w-0 shrink" />
    </span>
  );
}

/** One part of the state, a warning, cut to the column with the whole of it on hover. */
function Part({ label, title }: { label: string; title?: string }) {
  return (
    <span className="flex min-w-0 text-xs" title={title ?? label}>
      <StatusLabel tone="warning" label={label} labelClassName="truncate" className="min-w-0 shrink" />
    </span>
  );
}

function None() {
  return <span className="text-muted-foreground text-xs">—</span>;
}

/** What goes on in the repo first, as in its "In this repo" bar (ADR-103), with how many more; a click opens it. */
function Activity({
  items,
  onOpen,
  empty,
}: {
  items: readonly RepoActivityItem[];
  onOpen: (target: RepoActivityTarget) => void;
  empty: ReactNode;
}) {
  const [first] = items;
  if (!first) return empty;
  return (
    <button
      type="button"
      onClick={() => onOpen(first.open)}
      title={items.map((item) => `${item.name}: ${item.status.label}`).join("\n")}
      className="flex max-w-full min-w-0 items-center gap-1.5 text-left text-xs hover:underline"
    >
      <StatusLabel {...first.status} labelClassName="truncate" className="min-w-0 shrink" />
      {items.length > 1 && <span className="text-muted-foreground shrink-0">{`+${items.length - 1}`}</span>}
    </button>
  );
}

/** The words of the way out of a row, by the tab it opens; a row without one opens the repo as the list does. */
const OPEN_LABEL = { changes: "Changes", shell: "Shell" } as const;

/** The row's next step; after a pull, its result, which stays while the panel is open. */
function RowAction({ row, pull, onOpenRepo }: { row: AllReposRow; pull: PullHandle; onOpenRepo: (tab?: RepoTab) => void }) {
  const { state } = pull;
  if (state.kind === "done") {
    const result = pullResultLine(state.result);
    return (
      <span className="flex max-w-full min-w-0 text-xs" title={result.label}>
        <StatusLabel {...result} labelClassName="truncate" className="min-w-0 shrink" />
      </span>
    );
  }
  const { action } = row;
  if (action === null) return null;
  if (action.kind === "pull")
    return state.kind === "asking" || state.kind === "failed" ? null : <PullButton offer={action} pull={pull} variant="outline" />;
  const { tab } = action;
  return (
    <Button variant="ghost" size="sm" className="text-primary h-7 px-1" onClick={() => onOpenRepo(tab ?? undefined)}>
      {tab ? OPEN_LABEL[tab] : "Open"} <ArrowRight />
    </Button>
  );
}
