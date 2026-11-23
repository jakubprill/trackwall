import { BATCH_STEPS, type BatchStep, countLabel, type Repo, type RunningMiseTask, type SessionList } from "@trackwall/protocol";
import { ListChecks, Play, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { batchProgress, STEP_HINT, STEP_LABEL } from "@/lib/batch-state";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { toggle } from "@/lib/set-toggle";
import { workInRepoFolder } from "@/lib/upstream-pull";
import type { BatchRunHandle } from "@/lib/use-batch-run";
import { useRunningMiseTasks } from "@/lib/use-running-mise-tasks";
import { BatchResults } from "./BatchResults.tsx";

/** The batch command with what works in each repo's folder, read from the sessions and running mise tasks (ADR-271). */
export function BatchPanel({
  conn,
  batch,
  repos,
  sessions,
  runningLive,
}: {
  conn: Connection;
  batch: BatchRunHandle;
  repos: readonly Repo[];
  sessions: SessionList | undefined;
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
}) {
  const running = useRunningMiseTasks(conn, runningLive).data ?? [];
  return <BatchView conn={conn} batch={batch} repos={repos} workInFolder={(repo) => workInRepoFolder(repo, sessions, running)} />;
}

/**
 * The batch command (ADR-27): choosing steps and repos, start, cancel and the result of every step in every repo. `repos`
 * is the repo list after the tag filter (ADR-25), so the filter picks a group of repos, and it can be narrowed by hand here.
 */
export function BatchView({
  conn,
  batch,
  repos,
  workInFolder,
}: {
  conn: Connection;
  batch: BatchRunHandle;
  repos: readonly Repo[];
  /** What works in a repo's folder itself (`workInRepoFolder`), which putting changes aside leaves out (ADR-271). */
  workInFolder: (repo: string) => readonly string[];
}) {
  // Nothing is ticked at the start: the user picks what runs, so a build of every repo never starts on a click by habit.
  const [steps, setSteps] = useState<ReadonlySet<BatchStep>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const chosen = repos.filter((r) => selected.has(r.id));
  const { run } = batch;
  const ready = chosen.length > 0 && steps.size > 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="hud-label">Batch command</span>
        <h1 className="text-xl font-semibold tracking-tight">The same steps on many repos at once</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Steps run one after another in each repo, three repos at a time. A failed step ends that repo; the others carry on. A mise task
          with <code>sources</code> and <code>outputs</code> is skipped when nothing changed, so a rerun is fast.
        </p>
      </header>
      <Surface label="Steps" meta={`${steps.size}/${BATCH_STEPS.length}`}>
        <AllOrNone onAll={() => setSteps(new Set(BATCH_STEPS))} onNone={() => setSteps(new Set())} />
        <ul className="grid sm:grid-cols-2">
          {BATCH_STEPS.map((step) => (
            <Choice key={step} checked={steps.has(step)} onChange={() => setSteps(toggle(steps, step))}>
              <span className="text-sm">{STEP_LABEL[step]}</span>
              <span className="text-muted-foreground text-xs">{STEP_HINT[step]}</span>
            </Choice>
          ))}
        </ul>
      </Surface>
      <Surface label="Repos" meta={`${chosen.length}/${repos.length}`}>
        <AllOrNone onAll={() => setSelected(new Set(repos.map((r) => r.id)))} onNone={() => setSelected(new Set())} />
        {/* Columns instead of one list: with a few dozen repos the results stay close to the start button. */}
        <ul className="grid grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <Choice key={repo.id} checked={selected.has(repo.id)} onChange={() => setSelected(toggle(selected, repo.id))}>
              <span className="truncate font-mono text-sm">{repo.id}</span>
            </Choice>
          ))}
        </ul>
      </Surface>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={batch.running || !ready}
          onClick={() => batch.start({ repos: chosen.map((r) => r.id), steps: BATCH_STEPS.filter((s) => steps.has(s)) })}
        >
          <Play /> Run on {countLabel(chosen.length, { one: "repo", other: "repos" })}
        </Button>
        {!ready && <span className="text-muted-foreground text-xs">Choose at least one step and one repo.</span>}
        {run?.finishedAt === null && (
          <Button variant="outline" size="sm" disabled={run.cancelled} onClick={batch.cancel}>
            <Square /> {run.cancelled ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>
      {batch.error && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{batch.error}</p>}
      {run === undefined && !batch.error && <Loading />}
      {run && <BatchResults conn={conn} run={run} workInFolder={workInFolder} />}
    </div>
  );
}

/** Under the list's header while a batch command runs (ADR-273): its progress and the way to its results. */
export function BatchBar({ batch, onShow }: { batch: BatchRunHandle; onShow: () => void }) {
  if (batch.run?.finishedAt !== null) return null;
  const progress = batchProgress(batch.run);
  return (
    <div className="flex px-4 pb-3">
      <Button variant="outline" size="sm" onClick={onShow}>
        <ListChecks /> {`Batch command ${progress.done}/${progress.total}`}
      </Button>
    </div>
  );
}

function AllOrNone({ onAll, onNone }: { onAll: () => void; onNone: () => void }) {
  return (
    <div className="flex gap-2 border-b px-3 py-2">
      <Button variant="ghost" size="sm" onClick={onAll}>
        All
      </Button>
      <Button variant="ghost" size="sm" onClick={onNone}>
        None
      </Button>
    </div>
  );
}

function Choice({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <li>
      <label className="hover:bg-accent flex cursor-pointer items-center gap-3 px-3 py-2">
        <input type="checkbox" className="accent-primary size-4 shrink-0" checked={checked} onChange={onChange} />
        <span className="flex min-w-0 flex-col">{children}</span>
      </label>
    </li>
  );
}
