import { type Repo, type RepoOverview, type RunningMiseTask, type SessionList, workspaceApi } from "@trackwall/protocol";
import { FolderOpen } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useContext, useState } from "react";
import { EditorButton } from "@/components/EditorButton";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
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
import { type RepoActivityTarget, repoActivity } from "@/lib/repo-activity";
import { REPO_TABS, type RepoTab } from "@/lib/repo-tabs";
import type { SessionSelection } from "@/lib/session-entries";
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
import { RepoStats } from "./RepoStats.tsx";

/** Streamdown with Mermaid is a few MB, so it goes into a separate file loaded only with the first README. */
const ReadmeMarkdown = lazy(() => import("./ReadmeMarkdown.tsx").then((m) => ({ default: m.ReadmeMarkdown })));

export function RepoDetail({
  conn,
  repo,
  projectsDir,
  sessions,
  runningLive,
  onOpenInSessions,
}: {
  conn: Connection;
  repo: Repo;
  /** The daemon's projects folder, for showing the repo through that folder on this computer (ADR-131); unknown until the list loads. */
  projectsDir: string | null | undefined;
  /** `undefined` until the first session list arrives: the bar then shows only mise tasks. */
  sessions: SessionList | undefined;
  /** Running mise tasks from the events; `undefined` for a moment after a connection change, and polled until then. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const [tab, setTab] = useState<RepoTab>(REPO_TABS[0].id);
  const running = useRunningMiseTasks(conn, runningLive);
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="hud-label">Repo</span>
          <h1 className="text-xl font-semibold tracking-tight">{repo.id}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">{repo.path}</p>
          {repo.remote && <p className="text-muted-foreground font-mono text-xs break-all">{repo.remote}</p>}
        </div>
        <RepoActions conn={conn} repo={repo} projectsDir={projectsDir} />
      </header>
      {status.kind === "loading" && <Loading />}
      {status.kind === "unavailable" && (
        <p className="text-destructive text-sm whitespace-pre-wrap">The repo is unavailable: {status.message}</p>
      )}
      {status.kind === "ok" && (
        <>
          <RepoStats status={status} onShowChanges={() => setTab("changes")} />
          <RepoActivityBar items={repoActivity(repo.id, sessions, running.data ?? [])} onOpen={openActivity} />
          <TabBar tabs={REPO_TABS} active={tab} onSelect={setTab} />
          {tab === "card" && <RepoCardView conn={conn} repo={repo.id} head={head} />}
          {tab === "files" && <RepoFiles conn={conn} repo={repo.id} head={head} />}
          {tab === "commits" && <Loaded remote={overview}>{(o) => <RepoCommits commits={o.commits} />}</Loaded>}
          {tab === "changes" && <RepoChanges conn={conn} repo={repo.id} refreshKey={head} />}
          {tab === "mise" && <RepoMiseTasks conn={conn} repo={repo.id} />}
          {tab === "readme" && <Loaded remote={overview}>{(o) => <Readme conn={conn} readme={o.readme} />}</Loaded>}
        </>
      )}
    </div>
  );
}

function Loaded({ remote, children }: { remote: RemoteHandle<RepoOverview>; children: (data: RepoOverview) => ReactNode }) {
  if (remote.error) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (!remote.data) return <Loading />;
  return children(remote.data);
}

/**
 * Opens the repo in VS Code or in the system's folder app (ADR-51); the daemon does it, so it works in the browser too,
 * except when the daemon has no desktop (ADR-120). In a container the page opens VS Code attached to it (ADR-121), and the
 * desktop app shows the folder through the projects folder on this computer, when the user has set it (ADR-131).
 */
function RepoActions({ conn, repo, projectsDir }: { conn: Connection; repo: Repo; projectsDir: string | null | undefined }) {
  const [error, setError] = useState<string>();
  const { desktop, container } = useContext(DaemonPlaceContext);
  const hostFolder = useHostFolder(desktop, projectsDir, repo.path);
  const open = (endpoint: typeof workspaceApi.openEditor | typeof workspaceApi.openFolder) => {
    setError(undefined);
    post(conn, endpoint, { repo: repo.id }).catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <div className="flex max-w-xs flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {desktop && (
          <Button variant="outline" size="sm" onClick={() => open(workspaceApi.openFolder)}>
            <FolderOpen /> Show in {FILE_MANAGER}
          </Button>
        )}
        {hostFolder && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(undefined);
              showInHostFolder(hostFolder).catch((err: unknown) => setError(errorMessage(err)));
            }}
          >
            <FolderOpen /> Show in {FILE_MANAGER}
          </Button>
        )}
        <EditorButton
          path={repo.path}
          label="Open in VS Code"
          onOpen={() => open(workspaceApi.openEditor)}
          disabled={repo.status.kind !== "ok"}
        />
      </div>
      {!desktop && !hostFolder && (
        <p className="text-muted-foreground text-right text-xs">{container ? IN_CONTAINER_NOTE : NO_DESKTOP_NOTE}</p>
      )}
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
            <ReadmeMarkdown conn={conn} text={readme.text} />
          </Suspense>
        </ReadmeFallback>
      ) : (
        <PlainReadme text={readme.text} />
      )}
    </Surface>
  );
}
