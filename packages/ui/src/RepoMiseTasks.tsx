import { type MiseTask, type MiseTasks, miseApi } from "@trackwall/protocol";
import { Play, ShieldCheck, Square } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { isLive, runStateLabel, showsLastLines } from "@/lib/run-state";
import { useRemote } from "@/lib/use-remote";

/** Stan tasków odpytywany często, bo użytkownik właśnie coś uruchomił albo zatrzymał i czeka na wynik. */
const POLL_MS = 2000;

/** Taski mise repo (ADR-20): lista z `mise tasks ls`, start i stop całej grupy procesów, stan uruchomienia. */
export function RepoMiseTasks({ conn, repo }: { conn: Connection; repo: string }) {
  const load = useCallback(() => post(conn, miseApi.tasks, { repo }), [conn, repo]);
  const remote = useRemote(load, { pollMs: POLL_MS });

  if (!remote.data) {
    return remote.error ? <ErrorWithRetry message={remote.error} onRetry={remote.reload} /> : <Loading />;
  }
  return <TaskList conn={conn} repo={repo} tasks={remote.data} onChange={remote.reload} />;
}

function TaskList({ conn, repo, tasks, onChange }: { conn: Connection; repo: string; tasks: MiseTasks; onChange: () => void }) {
  if (tasks.kind === "not_installed") {
    return (
      <p className="text-muted-foreground text-sm">
        Trackwall nie znalazł programu mise ({tasks.message}). Zainstaluj mise (mise.jdx.dev) i uruchom Trackwall ponownie.
      </p>
    );
  }
  if (tasks.kind === "untrusted") return <Untrusted conn={conn} repo={repo} message={tasks.message} onTrusted={onChange} />;
  if (tasks.kind === "error") return <ErrorWithRetry message={`mise: ${tasks.message}`} onRetry={onChange} />;
  if (tasks.tasks.length === 0) return <p className="text-muted-foreground text-sm">To repo nie ma tasków mise.</p>;
  return (
    <Surface label="Taski mise" meta={tasks.tasks.length}>
      <ul className="divide-y">
        {tasks.tasks.map((task) => (
          <TaskRow key={task.name} conn={conn} repo={repo} task={task} onChange={onChange} />
        ))}
      </ul>
    </Surface>
  );
}

function Untrusted({ conn, repo, message, onTrusted }: { conn: Connection; repo: string; message: string; onTrusted: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const trust = () => {
    setPending(true);
    setError(undefined);
    post(conn, miseApi.trust, { repo })
      .then(onTrusted, (err: unknown) => setError(errorMessage(err)))
      .finally(() => setPending(false));
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm">
        mise nie ufa konfiguracji tego repo, więc nie poda jej tasków. Zaufaj jej tylko wtedy, gdy znasz repo: konfiguracja mise może
        uruchamiać programy.
      </p>
      <p className="text-muted-foreground font-mono text-xs whitespace-pre-wrap break-all">{message}</p>
      <Button variant="outline" size="sm" onClick={trust} disabled={pending}>
        <ShieldCheck /> Zaufaj konfiguracji mise (mise trust)
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function TaskRow({ conn, repo, task, onChange }: { conn: Connection; repo: string; task: MiseTask; onChange: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = isLive(task.run);
  const state = runStateLabel(task.run);
  const act = () => {
    setPending(true);
    setError(undefined);
    post(conn, live ? miseApi.stop : miseApi.start, { repo, miseTask: task.name })
      .then(onChange, (err: unknown) => setError(errorMessage(err)))
      .finally(() => setPending(false));
  };

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
        <Button variant="outline" size="sm" onClick={act} disabled={pending || task.run?.kind === "stopping"}>
          {live ? <Square /> : <Play />} {live ? "Zatrzymaj" : "Uruchom"}
        </Button>
      </div>
      {showsLastLines(task.run) && (
        <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
          {task.run.lastLines.join("\n")}
        </pre>
      )}
      {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
    </li>
  );
}
