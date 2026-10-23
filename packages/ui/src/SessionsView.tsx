import { agentsApi, type Session, type SessionList, sessionNeedsAttention, workspaceApi } from "@trackwall/protocol";
import { BellRing, Play, Plus, Square, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime, twoDigits } from "@/lib/format";
import { nextWaiting, sessionStateLabel, waitingCount } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { SessionTerminal } from "./SessionTerminal.tsx";

/**
 * Widok „Sesje” (§4.4, ADR-25): kilka sesji Copilot CLI naraz, każda w repo z folderu z projektami. Po lewej lista
 * ze stanem każdej sesji i skokiem do następnej, która czeka na człowieka; po prawej terminal wybranej sesji.
 * Listę sesji odpytuje `App`, bo liczba czekających sesji jest też na pasku widoków.
 */
export function SessionsView({
  conn,
  sessions,
  selected,
  onSelect,
}: {
  conn: Connection;
  sessions: RemoteHandle<SessionList>;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const [starting, setStarting] = useState(false);
  const list = sessions.data?.sessions ?? [];
  const current = starting ? undefined : (list.find((s) => s.id === selected) ?? list[0]);
  const next = nextWaiting(list, current?.id);
  const waiting = waitingCount(list);

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">Sesje {sessions.data && <span className="text-primary">{`// ${twoDigits(list.length)}`}</span>}</h2>
          <Button variant="ghost" size="icon" onClick={() => setStarting(true)} aria-label="Nowa sesja Copilot CLI">
            <Plus />
          </Button>
        </div>
        {next && (
          <div className="px-4 pb-3">
            <Button variant="outline" size="sm" className="w-full" onClick={() => onSelect(next.id)}>
              <BellRing /> {waiting === 1 ? "Sesja czeka na Ciebie" : `Następna czekająca (${waiting})`}
            </Button>
          </div>
        )}
        <nav aria-label="Lista sesji" className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions.error && <ErrorWithRetry message={sessions.error} onRetry={sessions.reload} />}
          {sessions.data && list.length === 0 && (
            <p className="text-muted-foreground px-2 text-sm">Nie ma jeszcze sesji. Uruchom Copilot CLI w repo z folderu z projektami.</p>
          )}
          {list.map((session, i) => (
            <SessionListItem
              key={session.id}
              session={session}
              position={i + 1}
              active={session.id === current?.id}
              onSelect={() => {
                setStarting(false);
                onSelect(session.id);
              }}
            />
          ))}
        </nav>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">
        {!sessions.data && !sessions.error && (
          <div className="flex h-full items-center justify-center p-6">
            <Loading />
          </div>
        )}
        {sessions.data && (!current || starting) && (
          <NewSession
            conn={conn}
            onStarted={(session) => {
              setStarting(false);
              onSelect(session.id);
              sessions.reload();
            }}
            onCancel={list.length > 0 ? () => setStarting(false) : undefined}
          />
        )}
        {current && (
          <SessionPanel key={current.id} conn={conn} session={current} onChanged={sessions.reload} onClosed={() => onSelect(undefined)} />
        )}
      </section>
    </div>
  );
}

function SessionListItem({
  session,
  position,
  active,
  onSelect,
}: {
  session: Session;
  position: number;
  active: boolean;
  onSelect: () => void;
}) {
  const state = sessionStateLabel(session);
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
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{session.repo}</span>
          {sessionNeedsAttention(session) && <BellRing className="text-warning size-3.5 shrink-0" aria-label="czeka na Ciebie" />}
        </span>
        <span className="text-muted-foreground text-xs">
          <StateText state={state} />
        </span>
        {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
      </span>
    </button>
  );
}

function StateText({ state }: { state: ReturnType<typeof sessionStateLabel> }) {
  return state.tone ? <StatusLabel tone={state.tone} label={state.label} /> : <span>{state.label}</span>;
}

/** Nagłówek wybranej sesji (repo, stan, nad czym pracuje, przyciski) i jej terminal. */
function SessionPanel({
  conn,
  session,
  onChanged,
  onClosed,
}: {
  conn: Connection;
  session: Session;
  onChanged: () => void;
  onClosed: () => void;
}) {
  const live = session.run.kind !== "exited";
  const stop = useAction(() => post(conn, agentsApi.stop, { session: session.id }), onChanged);
  const dismiss = useAction(
    () => post(conn, agentsApi.dismiss, { session: session.id }),
    () => {
      onClosed();
      onChanged();
    },
  );
  const action = live ? stop : dismiss;
  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{session.repo}</span>
            <span className="text-muted-foreground text-xs">
              <StateText state={sessionStateLabel(session)} />
            </span>
            <span className="text-muted-foreground text-xs">{relativeTime(session.startedAt, new Date())}</span>
          </span>
          {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </div>
        {action.error && <span className="text-destructive max-w-xs truncate text-xs">{action.error}</span>}
        {live ? (
          <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
            <Square /> Zatrzymaj
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={dismiss.run} disabled={dismiss.pending}>
            <X /> Zamknij
          </Button>
        )}
      </header>
      <SessionTerminal conn={conn} session={session.id} live={live} />
    </>
  );
}

/** Wybór repo z folderu z projektami i start Copilot CLI w jego korzeniu. */
function NewSession({ conn, onStarted, onCancel }: { conn: Connection; onStarted: (s: Session) => void; onCancel?: () => void }) {
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const repos = useRemote(load);
  const [repo, setRepo] = useState<string>();
  const chosen = repo ?? repos.data?.repos[0]?.id;
  const start = useAction(() => post(conn, agentsApi.start, { repo: chosen ?? "" }), onStarted);

  return (
    <div className="flex flex-col gap-4 p-6">
      <h3 className="hud-label">Nowa sesja Copilot CLI</h3>
      <p className="text-muted-foreground max-w-prose text-sm">
        Copilot CLI startuje w korzeniu wybranego repo, w terminalu należącym do daemona, więc działa dalej po zamknięciu okna. Stan sesji
        (pracuje, czeka na Ciebie, prosi o zgodę) Trackwall odczytuje z hooków Copilot CLI.
      </p>
      {repos.error && <ErrorWithRetry message={repos.error} onRetry={repos.reload} />}
      {repos.data && repos.data.repos.length === 0 && (
        <p className="text-muted-foreground text-sm">W folderze z projektami nie ma repo. Ustaw folder albo sklonuj repo w widoku Repo.</p>
      )}
      {repos.data && repos.data.repos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Repo nowej sesji"
            value={chosen}
            onChange={(e) => setRepo(e.target.value)}
            className="border-input bg-card h-9 min-w-48 rounded-md border px-3 text-sm"
          >
            {repos.data.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <Button onClick={start.run} disabled={start.pending || !chosen}>
            <Play /> Uruchom
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Anuluj
            </Button>
          )}
        </div>
      )}
      {start.error && <p className="text-destructive text-sm whitespace-pre-wrap">{start.error}</p>}
    </div>
  );
}
