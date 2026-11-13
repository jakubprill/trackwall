import type { Task } from "@trackwall/protocol";
import { Pause } from "lucide-react";
import { pausedNote, stoppedNote } from "@/lib/task-pause";
import { useClock } from "@/lib/use-clock";

/** "12 min ago" moves by the minute. */
const CLOCK_MS = 30_000;

/**
 * The strip of a paused task (ADR-253) under its header: since when, what Resume brings back, and right after the pause
 * what it stopped (`stopped`, which only the click that paused it knows).
 */
export function PausedNotice({ task, stopped }: { task: Task; stopped: readonly string[] | undefined }) {
  const now = useClock(CLOCK_MS);
  if (task.paused === null) return null;
  const done = stopped === undefined ? null : stoppedNote(stopped);
  return (
    <section aria-label="Paused" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <Pause className="text-primary size-3.5 shrink-0" aria-hidden />
      <span className="text-muted-foreground min-w-0">{pausedNote(task.paused, now)}</span>
      {done && <span className="text-muted-foreground min-w-0">{done}</span>}
    </section>
  );
}
