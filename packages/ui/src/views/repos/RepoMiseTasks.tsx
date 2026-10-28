import { hasService, type MiseTask, type MiseTasks, miseApi, miseTaskLogSource } from "@trackwall/protocol";
import { Play, ScrollText, ShieldCheck, Square } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { MiseTaskLog } from "@/components/MiseTaskLog";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { miseTaskOriginLabel } from "@/lib/mise-task-origin";
import { isLive, runStateLabel, showsLastLines } from "@/lib/run-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { RepoLocalConfig } from "./RepoLocalConfig.tsx";
import { RepoService } from "./RepoService.tsx";

/**
 * Polling: often when something runs (the user waits for the result of a start or stop), rarely when nothing runs,
 * because every request is `mise tasks ls`, and in a trusted repo mise runs the config's `[env]` along the way.
 */
const POLL_LIVE_MS = 2000;
const POLL_IDLE_MS = 10_000;

/**
 * The repo's mise tasks (ADR-20): the list from `mise tasks ls`, each with where it is defined (ADR-110), start and stop of
 * the whole process group, the run state; above them the repo's local config files and their backup (ADR-86).
 */
export function RepoMiseTasks({ conn, repo }: { conn: Connection; repo: string }) {
  const load = useCallback(() => post(conn, miseApi.tasks, { repo }), [conn, repo]);
  const remote = useRemote(load, { pollMs: pollInterval });

  return (
    <div className="flex flex-col gap-4">
      {/* A restored mise.local.toml brings its mise tasks, so the list is fetched again at once. */}
      <RepoLocalConfig conn={conn} repo={repo} onRestored={remote.reload} />
      {remote.data ? (
        <TaskPanel conn={conn} repo={repo} tasks={remote.data} onChange={remote.reload} />
      ) : remote.error ? (
        <ErrorWithRetry message={remote.error} onRetry={remote.reload} />
      ) : (
        <Loading />
      )}
    </div>
  );
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
      <p className="text-muted-foreground text-sm">
        This repo has no mise tasks. Add them under [tasks] in mise.toml in the repo root, or in mise.local.toml to keep them out of git, to
        run setup, dev or build from here.
      </p>
    ) : (
      <div className="flex flex-col gap-4">
        {hasService(tasks.tasks) && <RepoService conn={conn} repo={repo} />}
        {rows(tasks.tasks, "mise tasks")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <NoList conn={conn} repo={repo} tasks={tasks} onChange={onChange} />
      {tasks.running.length > 0 && rows(tasks.running, "Still running")}
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
        Trackwall could not find mise ({tasks.message}). Install mise (mise.jdx.dev) and restart Trackwall.
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
        mise does not trust this repo's config, so it will not list its mise tasks. Trust it only if you know the repo: a mise config can
        run programs.
      </p>
      <p className="text-muted-foreground font-mono text-xs whitespace-pre-wrap break-all">{message}</p>
      <Button variant="outline" size="sm" onClick={trust.run} disabled={trust.pending}>
        <ShieldCheck /> Trust the mise config (mise trust)
      </Button>
      {trust.error && <p className="text-destructive text-xs">{trust.error}</p>}
    </div>
  );
}

function TaskRow({ conn, repo, task, onChange }: { conn: Connection; repo: string; task: MiseTask; onChange: () => void }) {
  const live = isLive(task.run);
  const state = runStateLabel(task.run);
  const [showLog, setShowLog] = useState(false);
  const origin = miseTaskOriginLabel(task);
  // Also while `stopping`: after `stop_unconfirmed` the stop can be retried, and the daemon merges parallel requests into one.
  const action = useAction(
    () => post(conn, live ? miseApi.stop : miseApi.start, { repo, miseTask: task.name }),
    () => {
      // Running opens the log: the user wants to see what the mise task does anyway.
      if (!live) setShowLog(true);
      onChange();
    },
  );

  return (
    <li className="flex flex-col gap-2 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <code className="text-primary truncate text-xs">{task.name}</code>
            {origin && (
              <Badge variant={origin.local ? "default" : "secondary"} title={origin.title}>
                {origin.label}
              </Badge>
            )}
          </span>
          {task.description && <span className="text-muted-foreground truncate text-xs">{task.description}</span>}
        </div>
        <span className="text-xs" title={task.run ? `started ${relativeTime(task.run.startedAt, new Date())}` : undefined}>
          <StatusLabel tone={state.tone} label={state.label} />
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowLog((v) => !v)} aria-pressed={showLog}>
          <ScrollText /> {showLog ? "Hide log" : "Log"}
        </Button>
        <Button variant="outline" size="sm" onClick={action.run} disabled={action.pending}>
          {live ? <Square /> : <Play />} {live ? "Stop" : "Run"}
        </Button>
      </div>
      {showLog && <MiseTaskLog conn={conn} source={miseTaskLogSource(repo, null, task.name)} />}
      {!showLog && showsLastLines(task.run) && (
        <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
          {task.run.lastLines.join("\n")}
        </pre>
      )}
      {action.error && <p className="text-destructive text-xs whitespace-pre-wrap">{action.error}</p>}
    </li>
  );
}
