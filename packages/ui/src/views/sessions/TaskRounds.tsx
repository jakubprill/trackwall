import { countLabel, type TaskRounds as Rounds, type TaskRound, taskRoundsApi } from "@trackwall/protocol";
import { Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { ROUNDS_POLL_MS, roundNote, shownRound, undoConsequence } from "@/lib/task-rounds";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/**
 * The task's "Rounds" tab (ADR-168): every turn of the agent that changed the worktree, newest first, with the diff of the
 * one picked, and "Undo round" for the newest round that stands. The daemon decides whether the undo is safe now and
 * says why not; the tab only shows that and asks once more before it undoes.
 */
export function TaskRounds({ conn, task, paused }: { conn: Connection; task: string; paused: boolean }) {
  const load = useCallback(() => post(conn, taskRoundsApi.rounds, { task }), [conn, task]);
  const rounds = useRemote(paused ? undefined : load, { pollMs: ROUNDS_POLL_MS });
  const [picked, setPicked] = useState<number | null>(null);
  if (rounds.error && !rounds.data) return <ErrorWithRetry message={rounds.error} onRetry={rounds.reload} />;
  if (!rounds.data) return <Loading />;
  const shown = shownRound(rounds.data.rounds, picked);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rounds.data.problem !== null && (
        <p className="text-warning text-sm">Warning: the last turn was not saved as a round: {rounds.data.problem}.</p>
      )}
      <UndoRound conn={conn} task={task} rounds={rounds.data} onUndone={rounds.reload} />
      {rounds.data.rounds.length === 0 ? (
        <p className="text-muted-foreground text-sm">No rounds yet: each turn of the agent that changes the worktree becomes one.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Rounds">
          {rounds.data.rounds.map((round) => (
            <li key={round.number}>
              <RoundRow round={round} selected={round.number === shown?.number} onSelect={() => setPicked(round.number)} />
            </li>
          ))}
        </ul>
      )}
      {shown && <RoundDiff key={shown.number} conn={conn} task={task} round={shown.number} />}
    </div>
  );
}

function RoundRow({ round, selected, onSelect }: { round: TaskRound; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-baseline gap-3 rounded-md px-2 py-1 text-left text-sm",
        selected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <span className={cn("shrink-0 font-medium", round.undoneAt !== null && "text-muted-foreground line-through")}>
        Round {round.number}
      </span>
      <span className="text-muted-foreground truncate text-xs">{roundNote(round, new Date())}</span>
    </button>
  );
}

/** "Undo round N", or why it cannot be undone now, and the confirmation before it. */
function UndoRound({ conn, task, rounds, onUndone }: { conn: Connection; task: string; rounds: Rounds; onUndone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const undo = useAction(
    (round: number) => post(conn, taskRoundsApi.undoRound, { task, round }),
    () => {
      setConfirming(false);
      onUndone();
    },
  );
  const round = rounds.undo;
  if (round === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div role="alertdialog" aria-label={`Undo round ${round}`} className="bg-card flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm">{undoConsequence(round)}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={undo.pending} onClick={() => undo.run(round)}>
              Undo round {round}
            </Button>
            <Button variant="ghost" size="sm" disabled={undo.pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={rounds.blocked !== null} onClick={() => setConfirming(true)}>
            <Undo2 /> Undo round {round}
          </Button>
          {rounds.blocked !== null && <p className="text-warning text-sm">{rounds.blocked}</p>}
        </div>
      )}
      {undo.error && <p className="text-destructive text-sm whitespace-pre-wrap">{undo.error}</p>}
    </div>
  );
}

/** One round's files and diff: a round never changes once it ended, so it is read once. */
function RoundDiff({ conn, task, round }: { conn: Connection; task: string; round: number }) {
  const load = useCallback(() => post(conn, taskRoundsApi.roundChanges, { task, round }), [conn, task, round]);
  const changes = useRemote(load);
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  return (
    <section aria-label={`Changes of round ${round}`} className="flex min-w-0 flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Round {round}: {countLabel(changes.data.files.length, { one: "file", other: "files" })}
      </p>
      <ChangesDiff changes={changes.data} />
    </section>
  );
}
