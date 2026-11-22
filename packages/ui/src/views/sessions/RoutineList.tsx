import { type RoutineEntry, type RoutineProblem, routinesApi, trackwallDirLabel } from "@trackwall/protocol";
import { Check, GitBranch } from "lucide-react";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { RemoveForGood } from "@/components/RemoveForGood";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { reloadOnRefusal } from "@/lib/reload-on-refusal";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

const ROUTINES_POLL_MS = 10_000;

/**
 * Routines under the New task form (ADR-173): tasks the user runs by hand again and again, written by an agent with
 * `propose_routine`. A routine runs only in the version the user approved, so a new or changed one shows its prompt
 * open with "Approve" instead of "Run"; both name the version shown, and the daemon refuses one that changed meanwhile.
 */
export function RoutineList({ conn, onStarted }: { conn: Connection; onStarted: (selection: SessionSelection) => void }) {
  const load = useCallback(() => post(conn, routinesApi.list, {}), [conn]);
  // A routine an agent saves while the form is open shows within the poll.
  const list = useRemote(load, { pollMs: ROUTINES_POLL_MS });
  if (list.error) return <ErrorWithRetry message={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { routines, problems } = list.data;
  return <RoutineSection conn={conn} routines={routines} problems={problems} onChanged={list.reload} onStarted={onStarted} />;
}

/**
 * The routines as read, with the files that are not routines: nothing while there are none, since the section would
 * only take room on the form of a new install (ADR-290); the first routine an agent proposes brings it.
 */
export function RoutineSection({
  conn,
  routines,
  problems,
  onChanged,
  onStarted,
}: {
  conn: Connection;
  routines: readonly RoutineEntry[];
  problems: readonly RoutineProblem[];
  onChanged: () => void;
  onStarted: (selection: SessionSelection) => void;
}) {
  if (routines.length === 0 && problems.length === 0) return null;
  return (
    <section aria-label="Routines" className="flex max-w-3xl flex-col gap-3 px-6 pb-6">
      <h3 className="hud-label">Routines</h3>
      {routines.map((routine) => (
        <RoutineRow key={`${routine.name}-${routine.digest}`} conn={conn} routine={routine} onChanged={onChanged} onStarted={onStarted} />
      ))}
      {problems.map((problem) => (
        <p key={problem.file} className="text-destructive text-xs">
          <span className="font-mono">{problem.file}</span>: {problem.message}
        </p>
      ))}
    </section>
  );
}

function RoutineRow({
  conn,
  routine,
  onChanged,
  onStarted,
}: {
  conn: Connection;
  routine: RoutineEntry;
  onChanged: () => void;
  onStarted: (selection: SessionSelection) => void;
}) {
  const seen = { name: routine.name, digest: routine.digest };
  const approve = useAction(() => reloadOnRefusal(post(conn, routinesApi.approve, seen), onChanged), onChanged);
  const run = useAction(
    () => reloadOnRefusal(post(conn, routinesApi.run, seen), onChanged),
    (task) => onStarted({ kind: "task", id: task.id }),
  );
  const pending = approve.pending || run.pending;
  const error = approve.error ?? run.error;
  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{routine.title}</span>
        <span className="text-muted-foreground font-mono text-xs">{routine.repo}</span>
        {routine.approvals === "auto" && <Badge variant="outline">runs without approvals</Badge>}
        {routine.model !== null && <Badge variant="outline">{routine.model}</Badge>}
        {!routine.approved && <Badge>needs your approval</Badge>}
      </div>
      <details open={!routine.approved}>
        <summary className="text-muted-foreground cursor-pointer text-xs">
          Prompt <span className="font-mono">{`${trackwallDirLabel("routines")}/${routine.name}.md`}</span>
        </summary>
        <pre className="text-foreground mt-2 max-h-64 overflow-y-auto font-mono text-xs whitespace-pre-wrap">{routine.prompt}</pre>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        {routine.approved ? (
          <Button size="sm" onClick={() => run.run()} disabled={pending}>
            <GitBranch /> Run
          </Button>
        ) : (
          <Button size="sm" onClick={() => approve.run()} disabled={pending}>
            <Check /> Approve this version
          </Button>
        )}
        <RemoveForGood remove={() => post(conn, routinesApi.remove, { name: routine.name })} disabled={pending} onRemoved={onChanged} />
      </div>
      {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
    </div>
  );
}
