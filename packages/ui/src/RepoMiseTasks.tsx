import { type MiseTask, type MiseTasks, miseApi } from "@trackwall/protocol";
import { Play, ScrollText, ShieldCheck, Square } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { isLive, runStateLabel, showsLastLines } from "@/lib/run-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { MiseTaskLog } from "@/MiseTaskLog";

/**
 * Odpytywanie: często, gdy coś działa (użytkownik czeka na wynik startu albo stopu), rzadko, gdy nic nie działa,
 * bo każde pytanie to `mise tasks ls`, a w zaufanym repo mise wykonuje przy tym `[env]` konfiguracji.
 */
const POLL_LIVE_MS = 2000;
const POLL_IDLE_MS = 10_000;

/** Taski mise repo (ADR-20): lista z `mise tasks ls`, start i stop całej grupy procesów, stan uruchomienia. */
export function RepoMiseTasks({ conn, repo }: { conn: Connection; repo: string }) {
  const load = useCallback(() => post(conn, miseApi.tasks, { repo }), [conn, repo]);
  const remote = useRemote(load, { pollMs: pollInterval });

  if (!remote.data) {
    return remote.error ? <ErrorWithRetry message={remote.error} onRetry={remote.reload} /> : <Loading />;
  }
  return <TaskPanel conn={conn} repo={repo} tasks={remote.data} onChange={remote.reload} />;
}

function pollInterval(tasks: MiseTasks | undefined): number {
  const live = tasks !== undefined && (tasks.kind === "ok" ? tasks.tasks : tasks.running).some((t) => isLive(t.run));
  return live ? POLL_LIVE_MS : POLL_IDLE_MS;
}

function TaskPanel({ conn, repo, tasks, onChange }: { conn: Connection; repo: string; tasks: MiseTasks; onChange: () => void }) {
  const rows = (list: MiseTask[], label: string) => (
    <Surface label={label} meta={list.length}>
      <ul className="divide-y">
        {list.map((task) => (
          <TaskRow key={task.name} conn={conn} repo={repo} task={task} onChange={onChange} />
        ))}
      </ul>
    </Surface>
  );
  if (tasks.kind === "ok") {
    return tasks.tasks.length === 0 ? (
      <p className="text-muted-foreground text-sm">To repo nie ma tasków mise.</p>
    ) : (
      rows(tasks.tasks, "Taski mise")
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <NoList conn={conn} repo={repo} tasks={tasks} onChange={onChange} />
      {tasks.running.length > 0 && rows(tasks.running, "Nadal działają")}
    </div>
  );
}

function NoList({
  conn,
  repo,
  tasks,
  onChange,
}: {
  conn: Connection;
  repo: string;
  tasks: Exclude<MiseTasks, { kind: "ok" }>;
  onChange: () => void;
}): ReactNode {
  if (tasks.kind === "not_installed") {
    return (
      <p className="text-muted-foreground text-sm">
        Trackwall nie znalazł programu mise ({tasks.message}). Zainstaluj mise (mise.jdx.dev) i uruchom Trackwall ponownie.
      </p>
    );
  }
  if (tasks.kind === "untrusted") return <Untrusted conn={conn} repo={repo} message={tasks.message} onTrusted={onChange} />;
  return <ErrorWithRetry message={`mise: ${tasks.message}`} onRetry={onChange} />;
}

function Untrusted({ conn, repo, message, onTrusted }: { conn: Connection; repo: string; message: string; onTrusted: () => void }) {
  const trust = useAction(() => post(conn, miseApi.trust, { repo }), onTrusted);
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm">
        mise nie ufa konfiguracji tego repo, więc nie poda jej tasków. Zaufaj jej tylko wtedy, gdy znasz repo: konfiguracja mise może
        uruchamiać programy.
      </p>
      <p className="text-muted-foreground font-mono text-xs whitespace-pre-wrap break-all">{message}</p>
      <Button variant="outline" size="sm" onClick={trust.run} disabled={trust.pending}>
        <ShieldCheck /> Zaufaj konfiguracji mise (mise trust)
      </Button>
      {trust.error && <p className="text-destructive text-xs">{trust.error}</p>}
    </div>
  );
}

function TaskRow({ conn, repo, task, onChange }: { conn: Connection; repo: string; task: MiseTask; onChange: () => void }) {
  const live = isLive(task.run);
  const state = runStateLabel(task.run);
  const [showLog, setShowLog] = useState(false);
  // Także przy `stopping`: po `stop_unconfirmed` stop można ponowić, a daemon łączy równoległe prośby w jedną.
  const action = useAction(
    () => post(conn, live ? miseApi.stop : miseApi.start, { repo, miseTask: task.name }),
    () => {
      // Uruchomienie otwiera log: użytkownik i tak chce zobaczyć, co task robi.
      if (!live) setShowLog(true);
      onChange();
    },
  );

  return (
    <li className="flex flex-col gap-2 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <code className="text-primary truncate text-xs">{task.name}</code>
          {task.description && <span className="text-muted-foreground truncate text-xs">{task.description}</span>}
        </div>
        <span className="text-xs" title={task.run ? `od ${relativeTime(task.run.startedAt, new Date())}` : undefined}>
          {state.tone ? (
            <StatusLabel tone={state.tone} label={state.label} />
          ) : (
            <span className="text-muted-foreground">{state.label}</span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowLog((v) => !v)} aria-pressed={showLog}>
          <ScrollText /> {showLog ? "Ukryj log" : "Log"}
        </Button>
        <Button variant="outline" size="sm" onClick={action.run} disabled={action.pending}>
          {live ? <Square /> : <Play />} {live ? "Zatrzymaj" : "Uruchom"}
        </Button>
      </div>
      {showLog && <MiseTaskLog conn={conn} repo={repo} miseTask={task.name} />}
      {!showLog && showsLastLines(task.run) && (
        <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
          {task.run.lastLines.join("\n")}
        </pre>
      )}
      {action.error && <p className="text-destructive text-xs whitespace-pre-wrap">{action.error}</p>}
    </li>
  );
}
