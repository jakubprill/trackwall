import { graphApi, miseApi, type SessionList, workspaceApi } from "@trackwall/protocol";
import type { LabelTarget } from "@trackwall/scene";
import { type HomeKey, parseHomeKey } from "@trackwall/scene/model";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { homeModel } from "@/lib/home-model";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { HomeDetails } from "./HomeDetails.tsx";
import { HomeHoverCard } from "./HomeHoverCard.tsx";
import { NeedsYouPanel } from "./NeedsYouPanel.tsx";

/**
 * Widok „Home” (ADR-33, §5.5): pierwszy ekran. Po lewej kolejka „Needs you” (sesje, które czekają albo mają błąd,
 * i repo, które nie są czyste), w środku pulpit 3D w układzie „Orbit”, po prawej szczegóły wybranego obiektu.
 * Klik wybiera, dwuklik albo przycisk w szczegółach przechodzi do sesji lub repo. Dane to te same odpowiedzi daemona
 * co w innych widokach; sesje odpytuje `App`, bo ich liczba jest też na pasku widoków. Poza płótnem widok bierze ze sceny
 * tylko `@trackwall/scene/model` (klucze i typy migawki), żeby three.js i Pawn zostały w leniwie ładowanym kawałku.
 */

const HomeCanvas = lazy(() => import("./HomeCanvas.tsx").then((m) => ({ default: m.HomeCanvas })));

/** Lista repo z gita: jak na liście repo, ale częściej, bo to pierwszy ekran. */
const REPOS_POLL_MS = 5000;
/** Graf liczy się z kart wszystkich repo, a zmienia się z commitami, więc rzadko. */
const GRAPH_POLL_MS = 30_000;
/** Działające taski mise to odczyt z pamięci daemona, bez uruchamiania mise. */
const RUNNING_POLL_MS = 3000;

export function HomeView({
  conn,
  sessions,
  onOpenSession,
  onOpenRepo,
  onOpenDaemon,
  onOpenSettings,
}: {
  conn: Connection;
  sessions: RemoteHandle<SessionList>;
  onOpenSession: (id: string) => void;
  onOpenRepo: (id: string) => void;
  onOpenDaemon: () => void;
  onOpenSettings: () => void;
}) {
  const repos = useRemote(
    useCallback(() => post(conn, workspaceApi.list, {}), [conn]),
    { pollMs: REPOS_POLL_MS },
  );
  const graph = useRemote(
    useCallback(() => post(conn, graphApi.graph, {}), [conn]),
    { pollMs: GRAPH_POLL_MS },
  );
  const running = useRemote(
    useCallback(() => post(conn, miseApi.running, {}), [conn]),
    { pollMs: RUNNING_POLL_MS },
  );
  const [selected, setSelected] = useState<HomeKey | null>(null);
  const [hovered, setHovered] = useState<HomeKey | null>(null);
  const [unavailable, setUnavailable] = useState<string>();

  const repoList = repos.data?.repos;
  const sessionList = sessions.data?.sessions;
  const model = useMemo(
    () =>
      homeModel({
        repos: repoList ?? [],
        sessions: sessionList ?? [],
        graph: graph.data,
        running: running.data ?? [],
        daemonRunning: repos.error === undefined,
      }),
    [repoList, sessionList, graph.data, running.data, repos.error],
  );
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
  const labelText = useCallback((target: LabelTarget) => {
    if (target.kind === "repo") return target.repo.id;
    return target.session.state === "error" ? "error" : "waiting for you";
  }, []);

  if (repos.data && repos.data.projectsDir === null) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm">Choose a projects folder to see your repos and sessions here.</p>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr_var(--spacing-sidebar)]">
      <NeedsYouPanel model={model} sessions={lookup.sessions} selected={selected} onSelect={setSelected} onOpen={open} />
      <div className="relative min-h-0 min-w-0">
        {unavailable ? (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">{`The 3D view is unavailable here (${unavailable}). The lists on both sides still work.`}</p>
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
              focus={selected}
              onSelect={setSelected}
              onOpen={open}
              onHover={setHovered}
              labelText={labelText}
              onUnavailable={setUnavailable}
            />
          </Suspense>
        )}
        {hovered && hovered !== selected && <HomeHoverCard target={hovered} model={model} />}
        {repos.error && <p className="text-destructive absolute bottom-3 left-3 text-sm">{repos.error}</p>}
      </div>
      <HomeDetails
        selected={selected}
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
