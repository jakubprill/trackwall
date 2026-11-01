import { type RoutineEntry, routinesApi, trackwallDirLabel } from "@trackwall/protocol";
import { Check, GitBranch, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * Routines under the New task form (ADR-173): tasks the user runs by hand again and again, written by an agent with
 * `propose_routine`. A routine runs only in the version the user approved, so a new or changed one shows its prompt
 * open with "Approve" instead of "Run"; both name the version shown, and the daemon refuses one that changed meanwhile.
 */
export function RoutineList({ conn, onStarted }: { conn: Connection; onStarted: (selection: SessionSelection) => void }) {
  const load = useCallback(() => post(conn, routinesApi.list, {}), [conn]);
  const list = useRemote(load);
  if (list.error) return <ErrorWithRetry message={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { routines, problems } = list.data;
  return (
    <section aria-label="Routines" className="flex max-w-3xl flex-col gap-3 px-6 pb-6">
      <h3 className="hud-label">Routines</h3>
      {routines.length === 0 && (
        <p className="text-muted-foreground max-w-prose text-xs">
          No routines yet. Ask an agent to prepare one, e.g. “prepare a routine that updates the orders API client and checks that it
          compiles”; it shows here for you to approve.
        </p>
      )}
      {routines.map((routine) => (
        <RoutineRow key={`${routine.name}-${routine.digest}`} conn={conn} routine={routine} onChanged={list.reload} onStarted={onStarted} />
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
  const approve = useAction(() => post(conn, routinesApi.approve, seen), onChanged);
  const run = useAction(
    () => post(conn, routinesApi.run, seen),
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
        <RoutineRemove conn={conn} name={routine.name} disabled={pending} onRemoved={onChanged} />
      </div>
      {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
    </div>
  );
}

/** Removing asks once more, since the file is gone for good. */
function RoutineRemove({ conn, name, disabled, onRemoved }: { conn: Connection; name: string; disabled: boolean; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const remove = useAction(() => post(conn, routinesApi.remove, { name }), onRemoved);
  if (!asking)
    return (
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setAsking(true)}>
        <Trash2 /> Remove
      </Button>
    );
  return (
    <>
      <Button variant="destructive" size="sm" disabled={disabled || remove.pending} onClick={() => remove.run()}>
        Remove for good
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep it
      </Button>
      {remove.error && <p className="text-destructive text-xs">{remove.error}</p>}
    </>
  );
}
