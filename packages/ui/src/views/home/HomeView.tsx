import { graphApi, miseApi, type SessionList, workspaceApi } from "@trackwall/protocol";
import { type HomeKey, parseHomeKey } from "@trackwall/scene/model";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { DaemonEvents } from "@/lib/daemon-events";
import { daemonAnswered, homeHasObject, homeModel } from "@/lib/home-model";
import { listNeedsSettings, REPO_LIST_POLL_MS } from "@/lib/repo-status";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { HomeDetails } from "./HomeDetails.tsx";
import { HomeHoverCard } from "./HomeHoverCard.tsx";
import { NeedsYouPanel } from "./NeedsYouPanel.tsx";

/**
 * Widok „Home” (ADR-33, §5.5): pierwszy ekran. Po lewej kolejka „Needs you” (sesje, które czekają albo mają błąd,
 * i repo, które nie są czyste), w środku pulpit 3D w układzie „Orbit”, po prawej szczegóły wybranego obiektu.
 * Klik wybiera, dwuklik albo przycisk w szczegółach przechodzi do sesji lub repo. Dane to te same odpowiedzi daemona
 * co w innych widokach; sesje i działające taski mise przychodzą na żywo z WebSocketu zdarzeń (ADR-36), a sesje
 * pobiera `App`, bo ich liczba jest też na pasku widoków. Poza płótnem widok bierze ze sceny
 * tylko `@trackwall/scene/model` (klucze i typy migawki), żeby three.js i Pawn zostały w leniwie ładowanym kawałku.
 */

const HomeCanvas = lazy(() => import("./HomeCanvas.tsx").then((m) => ({ default: m.HomeCanvas })));

/** Graf liczy się z kart wszystkich repo, a zmienia się z commitami, więc rzadko. */
const GRAPH_POLL_MS = 30_000;
/** Działające taski mise przychodzą na żywo z WebSocketu zdarzeń; odpytywane tylko bez jego połączenia. */
const RUNNING_POLL_MS = 3000;

export function HomeView({
  conn,
  events,
  sessions,
  onOpenSession,
  onOpenRepo,
  onOpenDaemon,
  onOpenSettings,
}: {
  conn: Connection;
  /** `undefined` przez chwilę po zmianie połączenia; do tego czasu taski mise są odpytywane. */
  events: DaemonEvents | undefined;
  sessions: RemoteHandle<SessionList>;
  onOpenSession: (id: string) => void;
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
  const runningLive = useMemo(() => events?.feed("mise.running.changed"), [events]);
  const running = useRemote(
    useCallback(() => post(conn, miseApi.running, {}), [conn]),
    { pollMs: RUNNING_POLL_MS, live: runningLive },
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
  // Wybór obiektu, który zniknął z migawki, przepada: nie wraca sam, gdy repo albo sesja o tym kluczu pojawi się znowu.
  const current = selected && homeHasObject(model, selected) ? selected : null;
  // Tylko przy wczytanych danych: po zmianie połączenia listy są chwilę puste, a obiekt wcale nie zniknął.
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
      if (target?.kind === "session") onOpenSession(target.id);
      if (target?.kind === "repo") onOpenRepo(target.id);
      if (target?.kind === "daemon") onOpenDaemon();
    },
    [onOpenSession, onOpenRepo, onOpenDaemon],
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
      <NeedsYouPanel model={model} sessions={lookup.sessions} selected={current} onSelect={setSelected} onOpen={open} />
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
