import { type CardWarmupProgress, graphApi, type SessionList, type Task } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { graphLoadingText } from "@/lib/card-warmup";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { twoDigits } from "@/lib/format";
import { repoProblems } from "@/lib/graph-labels";
import { layoutGraph } from "@/lib/graph-layout";
import { GRAPH_PACE } from "@/lib/repo-watch";
import { taskName } from "@/lib/session-entries";
import { impactRings } from "@/lib/task-impact";
import { useCardWarmup } from "@/lib/use-card-warmup";
import { useRemote } from "@/lib/use-remote";
import type { RepoWatchHandle } from "@/lib/use-repo-watch";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { GraphImpactPanel } from "./GraphImpactPanel.tsx";
import { GraphNodePanel, GraphSummaryPanel } from "./GraphNodePanel.tsx";

/** As in a task's Impact tab: a new commit's card is read once, later reads are cache hits. */
const IMPACT_POLL_MS = 10_000;

/**
 * The "Overview" view (§4.6, ADR-29): the graph of connections between repos at full width and the details panel of the
 * selected repo on the right. The daemon computes the graph from the repo cards, so a new commit in a repo changes it as soon as
 * the repo watch reports it (ADR-63). While the first graph is computed, the view shows how far the card warm-up is.
 * Choosing a task lights the repos its change reaches, ring by ring, and dims the rest (ADR-147).
 */
export function GraphView({
  conn,
  warmupLive,
  repoWatch,
  sessions,
  initialImpactTask,
}: {
  conn: Connection;
  warmupLive: LiveFeed<CardWarmupProgress> | undefined;
  repoWatch: RepoWatchHandle;
  /** The session list, whose tasks' impact the view can show. */
  sessions: SessionList | undefined;
  /** The task whose impact the view opens with, from its Impact tab. */
  initialImpactTask: string | undefined;
}) {
  const load = useCallback(() => post(conn, graphApi.graph, {}), [conn]);
  const graph = useRemote(load, repoWatch.options(GRAPH_PACE));
  const warmup = useCardWarmup(conn, warmupLive).data;
  const [selected, setSelected] = useState<string>();
  const [impactTask, setImpactTask] = useState(initialImpactTask);
  const loadImpact = useMemo(
    () => (impactTask === undefined ? undefined : () => post(conn, graphApi.changedEndpoints, { task: impactTask })),
    [conn, impactTask],
  );
  // A new task clears the last one's impact until its own comes; polled like the task's Impact tab.
  const impact = useRemote(loadImpact, { pollMs: IMPACT_POLL_MS });
  const changed = impactTask === undefined ? undefined : impact.data;
  const rings = useMemo(() => changed && impactRings(changed), [changed]);
  const data = graph.data;
  const layout = useMemo(
    () =>
      data &&
      layoutGraph(
        data.nodes.map((n) => n.repo),
        data.edges,
      ),
    [data],
  );
  // A repo missing from the refreshed graph (for example a deleted directory) has no panel; the selection comes back when the repo does.
  const node = data?.nodes.find((n) => n.repo === selected);
  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_24rem]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <h2 className="hud-label">Overview {data && <span className="text-primary">{`// ${twoDigits(data.nodes.length)}`}</span>}</h2>
          <ImpactPicker tasks={sessions?.tasks ?? []} task={impactTask} onChoose={setImpactTask} />
          <Button variant="ghost" size="icon" onClick={graph.reload} aria-label="Refresh graph">
            <RefreshCw />
          </Button>
        </header>
        {graph.error && (
          <div className="px-4 pb-3">
            <ErrorWithRetry message={graph.error} onRetry={graph.reload} />
          </div>
        )}
        {!data && !graph.error && (
          <div className="px-4">
            <Loading text={graphLoadingText(warmup)} />
          </div>
        )}
        {impact.error && impactTask !== undefined && (
          <div className="px-4 pb-3">
            <ErrorWithRetry message={impact.error} onRetry={impact.reload} />
          </div>
        )}
        {data && layout && <GraphCanvas graph={data} layout={layout} selected={node?.repo} impact={rings} onSelect={setSelected} />}
      </section>
      <aside className="bg-card min-h-0 overflow-y-auto border-l">
        {layout && node && (
          <GraphNodePanel
            node={node}
            pairs={layout.pairs}
            problems={data ? repoProblems(data, node.repo) : []}
            onSelect={setSelected}
            onClose={() => setSelected(undefined)}
          />
        )}
        {data && layout && !node && changed && <GraphImpactPanel changed={changed} onSelect={setSelected} />}
        {data && layout && !node && !changed && <GraphSummaryPanel graph={data} pairs={layout.pairs} />}
      </aside>
    </div>
  );
}

/** The task whose impact the graph lights; "None" shows the plain graph. */
function ImpactPicker({
  tasks,
  task,
  onChoose,
}: {
  tasks: readonly Task[];
  task: string | undefined;
  onChoose: (task: string | undefined) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <label className="text-muted-foreground ml-auto flex min-w-0 items-center gap-2 text-xs">
      Impact of
      <select
        value={task ?? ""}
        onChange={(e) => onChoose(e.target.value === "" ? undefined : e.target.value)}
        className="border-input bg-card h-8 max-w-64 min-w-0 truncate rounded-md border px-2 text-sm"
      >
        <option value="">no task</option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {`${t.repo} · ${taskName(t)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
