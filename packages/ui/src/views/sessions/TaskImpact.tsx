import { agentsApi, type ChangedEndpoint, type ChangedEndpoints, graphApi, type Task } from "@trackwall/protocol";
import { Network, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { ImpactRingBadge } from "@/components/ImpactRingBadge";
import { Loading } from "@/components/Loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { taskName } from "@/lib/session-entries";
import { contractChange, handoffPrompt, IMPACT_POLL_MS, impactPoints, impactSummary, RING_GAP, reachText } from "@/lib/task-impact";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { ImpactRings } from "./ImpactRings.tsx";

/**
 * The task's "Impact" tab (ADR-147): the endpoints the task's commits change, the repos that call them and, ring by
 * ring, the repos their endpoints reach, drawn round the task's repo. Each reached repo can be handed a task of its
 * own, which reads this task's change as if this task's session had proposed it (ADR-143). Commits only: the tab says
 * which commit it read.
 */
export function TaskImpact({
  conn,
  task,
  paused,
  onOpenTask,
  onShowOnOverview,
}: {
  conn: Connection;
  task: Task;
  paused: boolean;
  onOpenTask: (id: string) => void;
  /** Opens the Overview graph with this task's impact lit. */
  onShowOnOverview: (task: string) => void;
}) {
  const load = useCallback(() => post(conn, graphApi.changedEndpoints, { task: task.id }), [conn, task.id]);
  const changed = useRemote(paused ? undefined : load, { pollMs: IMPACT_POLL_MS });
  const [selected, setSelected] = useState<string>();
  if (changed.error && !changed.data) return <ErrorWithRetry message={changed.error} onRetry={changed.reload} />;
  if (!changed.data) return <Loading text="Comparing the task's endpoints with its base…" />;
  const data = changed.data;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm">{impactSummary(data)}</p>
        <span className="text-muted-foreground font-mono text-2xs" title="Only committed work counts">
          {`commit ${data.head.slice(0, 8)}`}
        </span>
        {data.impact.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => onShowOnOverview(task.id)}>
            <Network /> Show on Overview
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={changed.reload} aria-label="Refresh impact">
          <RefreshCw />
        </Button>
      </header>
      <ReadNotes changed={data} />
      {data.endpoints.length > 0 && (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,34rem)_1fr] xl:items-start">
          <ImpactRings
            repo={data.repo}
            points={impactPoints(data.repo, data.impact)}
            impact={data.impact}
            ringGap={RING_GAP}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="flex min-w-0 flex-col gap-4">
            <EndpointList endpoints={data.endpoints} />
            <ReachedRepos conn={conn} task={task} changed={data} selected={selected} onSelect={setSelected} onOpenTask={onOpenTask} />
          </div>
        </div>
      )}
    </div>
  );
}

/** What may make the comparison incomplete: contracts not compared, or problems on either card. */
function ReadNotes({ changed }: { changed: ChangedEndpoints }) {
  const notes = [
    !changed.contractsCompared && "A card was not fully parsed, so only added and removed endpoints are listed, not changed contracts.",
    ...changed.problems.map((p) => `${p.commit === "base" ? "Base" : "Head"}: ${p.message} (${p.path})`),
  ].filter((n) => n !== false);
  if (notes.length === 0) return null;
  return (
    <ul className="border-warning/40 bg-warning/10 flex flex-col gap-1 border px-3 py-2 text-xs">
      {notes.map((note) => (
        <li key={note} className="flex items-start gap-2">
          <TriangleAlert className="text-warning mt-0.5 size-3 shrink-0" aria-hidden />
          {note}
        </li>
      ))}
    </ul>
  );
}

const CHANGE_BADGE = { added: "success", removed: "destructive", changed: "secondary" } as const;

function EndpointList({ endpoints }: { endpoints: readonly ChangedEndpoint[] }) {
  return (
    <section aria-label="Changed endpoints" className="flex flex-col gap-2">
      <h3 className="hud-label">Changed endpoints</h3>
      <ul className="flex flex-col gap-2">
        {endpoints.map((e) => (
          <li key={`${e.change} ${e.app} ${e.method} ${e.path} ${e.after?.handler ?? e.before?.handler}`} className="surface px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant={CHANGE_BADGE[e.change]}>{e.change}</Badge>
              <span className="truncate font-mono text-sm">{`${e.method ?? "ANY"} ${e.path}`}</span>
              {e.app && <span className="text-muted-foreground font-mono text-2xs">{e.app}</span>}
            </div>
            <p className="text-muted-foreground pt-1 font-mono text-2xs">
              {[
                contractChange(e),
                e.dtos.length > 0 && `DTOs: ${e.dtos.join(", ")}`,
                e.change !== "added" && `${e.callers.length === 0 ? "no" : e.callers.length} callers`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReachedRepos({
  conn,
  task,
  changed,
  selected,
  onSelect,
  onOpenTask,
}: {
  conn: Connection;
  task: Task;
  changed: ChangedEndpoints;
  selected: string | undefined;
  onSelect: (repo: string | undefined) => void;
  onOpenTask: (id: string) => void;
}) {
  const [handingTo, setHandingTo] = useState<string>();
  if (changed.impact.length === 0) return null;
  return (
    <section aria-label="Reached repos" className="flex flex-col gap-2">
      <h3 className="hud-label">Reached repos</h3>
      <ul className="flex flex-col gap-2">
        {changed.impact.map((reached) => (
          <li
            key={reached.repo}
            className={cn("surface flex flex-col gap-2 px-3 py-2", selected === reached.repo && "border-primary")}
            onMouseEnter={() => onSelect(reached.repo)}
            onMouseLeave={() => onSelect(undefined)}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ImpactRingBadge reached={reached} />
              <span className="truncate font-mono text-sm">{reached.repo}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{reachText(changed, reached)}</span>
              {handingTo !== reached.repo && (
                <Button variant="outline" size="sm" onClick={() => setHandingTo(reached.repo)}>
                  <Send /> Hand off
                </Button>
              )}
            </div>
            {handingTo === reached.repo && (
              <HandoffForm
                conn={conn}
                task={task}
                repo={reached.repo}
                initialPrompt={handoffPrompt(changed, taskName(task), reached)}
                onStarted={(started) => {
                  setHandingTo(undefined);
                  onOpenTask(started.id);
                }}
                onCancel={() => setHandingTo(undefined)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The start of a task in a reached repo, handed this task's work (ADR-147): the prompt is the user's to edit, the
 * agent asks before tools, and the new task opens once its session runs.
 */
function HandoffForm({
  conn,
  task,
  repo,
  initialPrompt,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  task: Task;
  repo: string;
  initialPrompt: string;
  onStarted: (task: Task) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const start = useAction(() => post(conn, agentsApi.createTask, { repo, prompt, approvals: "ask", handoffFrom: task.id }), onStarted);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start.run();
      }}
    >
      <Textarea aria-label={`Prompt of the task in ${repo}`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={start.pending || prompt.trim() === ""}>
          {start.pending ? "Starting…" : `Start task in ${repo}`}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={start.pending}>
          Cancel
        </Button>
        {start.error && <span className="text-destructive text-xs">{start.error}</span>}
      </div>
    </form>
  );
}
