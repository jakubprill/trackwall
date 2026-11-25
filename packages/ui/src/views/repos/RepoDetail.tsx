import { type Repo, type RepoOverview, type RunningMiseTask, type SessionList, workspaceApi } from "@trackwall/protocol";
import { FolderOpen, Trash2 } from "lucide-react";
import { type ReactNode, Suspense, useCallback, useContext, useState } from "react";
import { EditorButton } from "@/components/EditorButton";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { FolderShell } from "@/components/FolderShell";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { DaemonPlaceContext, IN_CONTAINER_NOTE, NO_DESKTOP_NOTE } from "@/lib/desktop";
import { TRUNCATED_NOTE } from "@/lib/format";
import { showInHostFolder } from "@/lib/host-folder";
import { FILE_MANAGER } from "@/lib/platform";
import { type RepoActivityItem, type RepoActivityTarget, repoActivity } from "@/lib/repo-activity";
import { removalBlockers } from "@/lib/repo-removal";
import { REPO_TABS, type RepoTab } from "@/lib/repo-tabs";
import type { SessionSelection } from "@/lib/session-entries";
import { workInRepoFolder } from "@/lib/upstream-pull";
import { useHostFolder } from "@/lib/use-host-folder";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { useRunningMiseTasks } from "@/lib/use-running-mise-tasks";
import { PlainReadme, ReadmeFallback } from "./ReadmeFallback.tsx";
import { RepoActivityBar } from "./RepoActivityBar.tsx";
import { RepoCardView } from "./RepoCardView.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import { RepoCommits } from "./RepoCommits.tsx";
import { RepoFiles } from "./RepoFiles.tsx";
import { RepoMiseTasks } from "./RepoMiseTasks.tsx";
import { RepoRemoval } from "./RepoRemoval.tsx";
import { RepoStats } from "./RepoStats.tsx";

export function RepoDetail({
  conn,
  repo,
  initialTab = REPO_TABS[0].id,
  projectsDir,
  newOnServer,
  sessions,
  runningLive,
  onOpenInSessions,
  onRemoved,
}: {
  conn: Connection;
  repo: Repo;
  /** The tab the repo opens on: a row of All repos opens it where its way out is (ADR-293). */
  initialTab?: RepoTab;
  /** The daemon's projects folder, for showing the repo through that folder on this computer (ADR-131); unknown until the list loads. */
  projectsDir: string | null | undefined;
  /** The server check found commits the repo has not fetched (ADR-295): its Upstream tile offers the pull. */
  newOnServer: boolean;
  /** `undefined` until the first session list arrives: the bar then shows only mise tasks. */
  sessions: SessionList | undefined;
  /** Running mise tasks from the events; `undefined` for a moment after a connection change, and polled until then. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onOpenInSessions: (selection: SessionSelection) => void;
  /** The repo's folder moved out of the projects folder (ADR-300), to `movedTo`. */
  onRemoved: (movedTo: string) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const running = useRunningMiseTasks(conn, runningLive).data ?? [];
  const openActivity = (target: RepoActivityTarget) => {
    if (target.view === "mise") setTab("mise");
    else onOpenInSessions(target.selection);
  };
  const { status } = repo;
  const available = status.kind === "ok";
  // A new commit (for example from a terminal) changes HEAD in the polled list, and that fetches the overview and the tree anew.
  const head = status.kind === "ok" ? (status.head?.hash ?? "") : "";
  const load = useCallback(() => post(conn, workspaceApi.overview, { repo: repo.id }), [conn, repo.id]);
  const overview = useRemote(available ? load : undefined, { refreshKey: head });

  return (
    <div className="flex flex-col gap-4 p-6">
      <RepoHeader
        conn={conn}
        repo={repo}
        projectsDir={projectsDir}
        blockers={removalBlockers(repo.id, sessions, running)}
        onOpen={openActivity}
        onRemoved={onRemoved}
      />
      {status.kind === "loading" && <Loading />}
      {status.kind === "unavailable" && (
        <p className="text-destructive text-sm whitespace-pre-wrap">The repo is unavailable: {status.message}</p>
      )}
      {status.kind === "ok" && (
        <>
          <RepoStats
            conn={conn}
            repo={repo.id}
            status={status}
            newOnServer={newOnServer}
            workInFolder={workInRepoFolder(repo.id, sessions, running)}
            onShowChanges={() => setTab("changes")}
            onOpenShell={() => setTab("shell")}
          />
          <RepoActivityBar items={repoActivity(repo.id, sessions, running)} onOpen={openActivity} />
          <TabBar tabs={REPO_TABS} active={tab} onSelect={setTab} />
          {tab === "card" && (
            <RepoCardView
              conn={conn}
              repo={repo.id}
              head={head}
              onOpenMiseTasks={() => setTab("mise")}
              onOpenInSessions={onOpenInSessions}
            />
          )}
          {tab === "files" && <RepoFiles conn={conn} repo={repo.id} head={head} />}
          {tab === "commits" && <Loaded remote={overview}>{(o) => <RepoCommits commits={o.commits} />}</Loaded>}
          {tab === "changes" && <RepoChanges conn={conn} repo={repo.id} refreshKey={head} />}
          {tab === "mise" && <RepoMiseTasks conn={conn} repo={repo.id} />}
          {tab === "shell" && (
            // A fixed height in the scrolling page: the terminal fits itself to its frame, and the frame to nothing else.
            <div className="flex h-[70vh] flex-col overflow-hidden rounded-md border">
              <FolderShell conn={conn} place={{ repo: repo.id, task: null }} folder={repo.path} />
            </div>
          )}
          {tab === "readme" && <Loaded remote={overview}>{(o) => <Readme conn={conn} readme={o.readme} />}</Loaded>}
        </>
      )}
    </div>
  );
}

/** The repo's name, paths and actions, and under them the removal panel once "Remove…" opens it (ADR-300). */
function RepoHeader({
  conn,
  repo,
  projectsDir,
  blockers,
  onOpen,
  onRemoved,
}: {
  conn: Connection;
  repo: Repo;
  projectsDir: string | null | undefined;
  blockers: readonly RepoActivityItem[];
  onOpen: (target: RepoActivityTarget) => void;
  onRemoved: (movedTo: string) => void;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="hud-label">Repo</span>
          <h1 className="text-xl font-semibold tracking-tight">{repo.id}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">{repo.path}</p>
          {repo.remote && <p className="text-muted-foreground font-mono text-xs break-all">{repo.remote}</p>}
        </div>
        <RepoActions conn={conn} repo={repo} projectsDir={projectsDir} onRemove={() => setRemoving(true)} />
      </header>
      {removing && (
        <RepoRemoval
          conn={conn}
          repo={repo}
          blockers={blockers}
          onOpen={onOpen}
          onRemoved={onRemoved}
          onCancel={() => setRemoving(false)}
        />
      )}
    </>
  );
}

function Loaded({ remote, children }: { remote: RemoteHandle<RepoOverview>; children: (data: RepoOverview) => ReactNode }) {
  if (remote.error) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (!remote.data) return <Loading />;
  return children(remote.data);
}

/**
 * Opens the repo in VS Code or in the system's folder app (ADR-51); the daemon does it, so it works in the browser too,
 * except when the daemon has no desktop (ADR-120). In a container the page opens VS Code in it (ADR-121), and the
 * desktop app shows the folder through the projects folder on this computer, when the user has set it (ADR-131).
 * "Remove…" comes last and only opens the removal panel (ADR-300).
 */
function RepoActions({
  conn,
  repo,
  projectsDir,
  onRemove,
}: {
  conn: Connection;
  repo: Repo;
  projectsDir: string | null | undefined;
  /** Opens the removal panel (ADR-300); one click removes nothing. */
  onRemove: () => void;
}) {
  const [error, setError] = useState<string>();
  const { desktop, container } = useContext(DaemonPlaceContext);
  const hostFolder = useHostFolder(projectsDir, repo.path);
  const act = (request: () => Promise<unknown>) => {
    setError(undefined);
    request().catch((err: unknown) => setError(errorMessage(err)));
  };
  const open = (endpoint: typeof workspaceApi.openEditor | typeof workspaceApi.openFolder) =>
    act(() => post(conn, endpoint, { repo: repo.id }));
  // The daemon shows the folder on its desktop; without one, the desktop app shows it through the folder on this computer.
  const showFolder = desktop ? () => open(workspaceApi.openFolder) : hostFolder && (() => act(() => showInHostFolder(hostFolder)));

  return (
    <div className="flex max-w-xs flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {showFolder && (
          <Button variant="outline" size="sm" onClick={showFolder}>
            <FolderOpen /> Show in {FILE_MANAGER}
          </Button>
        )}
        <EditorButton
          path={repo.path}
          label="Open in VS Code"
          onOpen={() => open(workspaceApi.openEditor)}
          disabled={repo.status.kind !== "ok"}
        />
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
          <Trash2 /> Remove…
        </Button>
      </div>
      {!showFolder && <p className="text-muted-foreground text-right text-xs">{container ? IN_CONTAINER_NOTE : NO_DESKTOP_NOTE}</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function Readme({ conn, readme }: { conn: Connection; readme: RepoOverview["readme"] }) {
  if (!readme) return <p className="text-muted-foreground text-sm">This repo has no README in the latest commit.</p>;
  return (
    <Surface path={readme.path} note={readme.truncated ? TRUNCATED_NOTE : undefined}>
      {readme.format === "markdown" ? (
        <ReadmeFallback key={readme.text} text={readme.text}>
          <Suspense fallback={<Loading />}>
            <LazyMarkdown conn={conn} text={readme.text} source="readme" className="p-4" />
          </Suspense>
        </ReadmeFallback>
      ) : (
        <PlainReadme text={readme.text} />
      )}
    </Surface>
  );
}
