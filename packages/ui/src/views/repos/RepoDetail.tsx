import { type Repo, type RepoOverview, workspaceApi } from "@trackwall/protocol";
import { Code, FolderOpen } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { TRUNCATED_NOTE } from "@/lib/format";
import { FILE_MANAGER } from "@/lib/platform";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { PlainReadme, ReadmeFallback } from "./ReadmeFallback.tsx";
import { RepoCardView } from "./RepoCardView.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import { RepoCommits } from "./RepoCommits.tsx";
import { RepoFiles } from "./RepoFiles.tsx";
import { RepoMiseTasks } from "./RepoMiseTasks.tsx";
import { RepoStats } from "./RepoStats.tsx";

/** Streamdown with Mermaid is a few MB, so it goes into a separate file loaded only with the first README. */
const ReadmeMarkdown = lazy(() => import("./ReadmeMarkdown.tsx").then((m) => ({ default: m.ReadmeMarkdown })));

const TABS = [
  { id: "readme", label: "README" },
  { id: "card", label: "Card" },
  { id: "files", label: "Files" },
  { id: "commits", label: "Commits" },
  { id: "changes", label: "Changes" },
  { id: "mise", label: "mise tasks" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function RepoDetail({ conn, repo }: { conn: Connection; repo: Repo }) {
  const [tab, setTab] = useState<Tab>("readme");
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
        <RepoActions conn={conn} repo={repo} />
      </header>
      {status.kind === "unavailable" ? (
        <p className="text-destructive text-sm whitespace-pre-wrap">The repo is unavailable: {status.message}</p>
      ) : (
        <>
          <RepoStats status={status} onShowChanges={() => setTab("changes")} />
          <TabBar tabs={TABS} active={tab} onSelect={setTab} />
          {tab === "readme" && <Loaded remote={overview}>{(o) => <Readme conn={conn} readme={o.readme} />}</Loaded>}
          {tab === "commits" && <Loaded remote={overview}>{(o) => <RepoCommits commits={o.commits} />}</Loaded>}
          {tab === "changes" && <RepoChanges conn={conn} repo={repo.id} refreshKey={head} />}
          {tab === "card" && <RepoCardView conn={conn} repo={repo.id} head={head} />}
          {tab === "files" && <RepoFiles conn={conn} repo={repo.id} head={head} />}
          {tab === "mise" && <RepoMiseTasks conn={conn} repo={repo.id} />}
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

/** Opens the repo in VS Code or in the system's folder app (ADR-51); the daemon does it, so it works in the browser too. */
function RepoActions({ conn, repo }: { conn: Connection; repo: Repo }) {
  const [error, setError] = useState<string>();
  const open = (endpoint: typeof workspaceApi.openEditor | typeof workspaceApi.openFolder) => {
    setError(undefined);
    post(conn, endpoint, { repo: repo.id }).catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => open(workspaceApi.openFolder)}>
          <FolderOpen /> Show in {FILE_MANAGER}
        </Button>
        <Button variant="outline" size="sm" onClick={() => open(workspaceApi.openEditor)} disabled={repo.status.kind !== "ok"}>
          <Code /> Open in VS Code
        </Button>
      </div>
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
