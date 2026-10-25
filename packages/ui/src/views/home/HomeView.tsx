import { graphApi, miseApi, type RunningMiseTask, type SessionList, workspaceApi } from "@trackwall/protocol";
import { type HomeKey, parseHomeKey } from "@trackwall/scene/model";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { daemonAnswered, homeHasObject, homeModel } from "@/lib/home-model";
import { listNeedsSettings, REPO_LIST_POLL_MS } from "@/lib/repo-status";
import { RUNNING_MISE_POLL_MS } from "@/lib/run-state";
import type { SessionSelection } from "@/lib/session-entries";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { HomeDetails } from "./HomeDetails.tsx";
import { HomeHoverCard } from "./HomeHoverCard.tsx";
import { NeedsYouPanel } from "./NeedsYouPanel.tsx";

/**
 * The "Home" view (ADR-33, §5.5): the first screen. On the left the "Needs you" queue (sessions that are waiting or have
 * an error, task proposals waiting for a decision, and repos that are not clean), in the middle the 3D dashboard in the
 * "Orbit" layout, on the right the details of the selected object. A click selects; a double click or the button in the
 * details goes to the session or repo. The data is the same daemon responses as in other views; sessions and running mise
 * tasks come live from the events WebSocket (ADR-36), and `App` fetches the sessions, because their count is also on the
 * view bar. Outside the canvas the view takes only `@trackwall/scene/model` from the scene (keys and snapshot types), so
 * that three.js and Pawn stay in the lazily loaded chunk.
 */

const HomeCanvas = lazy(() => import("./HomeCanvas.tsx").then((m) => ({ default: m.HomeCanvas })));

/** The graph is computed from the cards of all repos and changes with commits, so rarely. */
const GRAPH_POLL_MS = 30_000;

export function HomeView({
  conn,
  runningLive,
  sessions,
  onOpenInSessions,
  onOpenRepo,
  onOpenDaemon,
  onOpenSettings,
}: {
  conn: Connection;
  /** Running mise tasks from the events; `undefined` for a moment after a connection change, and polled until then. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  sessions: RemoteHandle<SessionList>;
  /** Go to the Sessions view with a session or a task proposal. */
  onOpenInSessions: (selection: SessionSelection) => void;
  onOpenRepo: (id: string) => void;
  onOpenDaemon: () => void;
  onOpenSettings: () => void;
}) {
  const repos = useRemote(
    useCallback(() => post(conn, workspaceApi.list, {}), [conn]),
    { pollMs: REPO_LIST_POLL_MS },
  );
  const graph = useRemote(
    useCallback(() => post(conn, graphApi.graph, {}), [conn]),
    { pollMs: GRAPH_POLL_MS },
  );
  const running = useRemote(
    useCallback(() => post(conn, miseApi.running, {}), [conn]),
    { pollMs: RUNNING_MISE_POLL_MS, live: runningLive },
  );
  const [selected, setSelected] = useState<HomeKey | null>(null);
  const [hovered, setHovered] = useState<HomeKey | null>(null);
  const [unavailable, setUnavailable] = useState<string>();

  const daemonRunning = daemonAnswered(repos.error, repos.errorCode);
  const repoList = repos.data?.repos;
  const sessionList = sessions.data?.sessions;
  const model = useMemo(
    () =>
      homeModel({
        repos: repoList ?? [],
        sessions: sessionList ?? [],
        graph: graph.data,
        running: running.data ?? [],
        daemonRunning,
      }),
    [repoList, sessionList, graph.data, running.data, daemonRunning],
  );
  // A selection of an object that vanished from the dashboard snapshot is dropped: it does not come back by itself when a repo
  // or session with that key appears again.
  const current = selected && homeHasObject(model, selected) ? selected : null;
  // Only with loaded data: after a connection change the lists are empty for a moment, and the object has not vanished at all.
  const loaded = repoList !== undefined && sessionList !== undefined;
  useEffect(() => {
    if (loaded && selected && !current) setSelected(null);
  }, [loaded, selected, current]);
  const unavailableNow = useCallback((reason: string) => {
    setHovered(null);
    setUnavailable(reason);
  }, []);
  const lookup = useMemo(
    () => ({ repos: new Map((repoList ?? []).map((r) => [r.id, r])), sessions: new Map((sessionList ?? []).map((s) => [s.id, s])) }),
    [repoList, sessionList],
  );

  const open = useCallback(
    (key: HomeKey) => {
      const target = parseHomeKey(key);
      if (target?.kind === "session") onOpenInSessions({ kind: "session", id: target.id });
      if (target?.kind === "repo") onOpenRepo(target.id);
      if (target?.kind === "daemon") onOpenDaemon();
    },
    [onOpenInSessions, onOpenRepo, onOpenDaemon],
  );

  const needsSettings = listNeedsSettings(repos.errorCode);
  if (needsSettings || repos.data?.projectsDir === null) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm">{needsSettings ? repos.error : "Choose a projects folder to see your repos and sessions here."}</p>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr_var(--spacing-sidebar)]">
      <NeedsYouPanel
        model={model}
        sessions={lookup.sessions}
        proposals={sessions.data?.proposals ?? []}
        selected={current}
        onSelect={setSelected}
        onOpen={open}
        onOpenProposal={(id) => onOpenInSessions({ kind: "proposal", id })}
      />
      <div className="relative min-h-0 min-w-0">
        {unavailable ? (
          <div className="flex flex-col items-start gap-3 p-6">
            <p className="text-muted-foreground text-sm">{`The 3D view is unavailable here (${unavailable}). The lists on both sides still work.`}</p>
            <Button variant="outline" size="sm" onClick={() => setUnavailable(undefined)}>
              Try again
            </Button>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="p-6">
                <Loading text="Loading the 3D view…" />
              </div>
            }
          >
            <HomeCanvas
              model={model}
              focus={current}
              onSelect={setSelected}
              onOpen={open}
              onHover={setHovered}
              onUnavailable={unavailableNow}
            />
          </Suspense>
        )}
        {!unavailable && hovered && hovered !== current && <HomeHoverCard target={hovered} model={model} />}
        {repos.error && <p className="text-destructive absolute bottom-3 left-3 text-sm">{repos.error}</p>}
      </div>
      <HomeDetails
        selected={current}
        model={model}
        repos={lookup.repos}
        sessions={lookup.sessions}
        running={running.data ?? []}
        onSelect={setSelected}
        onOpen={open}
      />
    </div>
  );
}
