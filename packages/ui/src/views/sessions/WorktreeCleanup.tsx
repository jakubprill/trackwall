import { agentsApi, type TaskWorktree, type TaskWorktreeSize } from "@trackwall/protocol";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { formatBytes, relativeTime } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import {
  cleanupCandidates,
  DEFAULT_IDLE_DAYS,
  IDLE_DAYS_CHOICES,
  type IdleDays,
  initiallySelected,
  lossLabel,
  lossyTasks,
  removable,
  removeRequest,
} from "@/lib/worktree-cleanup";

/** One task's end in the cleanup: removed, or the daemon's refusal or error. */
interface Ended {
  task: string;
  branch: string;
  problem: string | null;
}

/**
 * The cleanup of old task worktrees (ADR-210) under the New task form: the tasks without a running session idle for at
 * least the chosen days, with the disk their worktree takes and what ending them would delete. "Remove worktrees" ends
 * the chosen tasks one by one as "End task" with the branch kept; a task that would lose work is not chosen at the
 * start, and choosing it asks once more, naming what goes, before anything is removed, and the daemon refuses it if
 * its worktree changed since. A task whose loss could not be read cannot be chosen: its own "End task" handles it.
 */
export function WorktreeCleanup({ conn, onRemoved }: { conn: Connection; onRemoved: () => void }) {
  const load = useCallback(() => post(conn, agentsApi.taskWorktrees, {}), [conn]);
  const list = useRemote(load);
  const [days, setDays] = useState<IdleDays>(DEFAULT_IDLE_DAYS);
  const candidates = useMemo(() => cleanupCandidates(list.data ?? [], days, new Date()), [list.data, days]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(initiallySelected(candidates)), [candidates]);
  const sizes = useWorktreeSizes(conn, candidates);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState<Ended[]>([]);

  if (list.error) return <ErrorWithRetry message={list.error} onRetry={list.reload} />;
  if (!list.data || list.data.length === 0) return null;
  const lossy = lossyTasks(candidates, selected);
  const toggle = (task: string) =>
    setSelected((before) => {
      const after = new Set(before);
      if (!after.delete(task)) after.add(task);
      return after;
    });
  const remove = async () => {
    setConfirming(false);
    setRunning(true);
    const chosen = candidates.filter((w) => selected.has(w.task));
    const results: Ended[] = [];
    // One after another: each end waits for its worktree's git reads, and several at once compete for the same disk.
    for (const worktree of chosen) {
      const problem = await post(conn, agentsApi.removeTask, removeRequest(worktree)).then(
        () => null,
        (err: unknown) => errorMessage(err),
      );
      results.push({ task: worktree.task, branch: worktree.branch, problem });
    }
    setEnded(results);
    setRunning(false);
    list.reload();
    onRemoved();
  };

  return (
    <section aria-label="Old task worktrees" className="flex max-w-3xl flex-col gap-3 px-6 pb-6">
      <div className="flex items-center gap-3">
        <h3 className="hud-label">Old task worktrees</h3>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          idle for at least
          <select
            className="bg-background rounded-md border px-1 py-0.5"
            value={days}
            onChange={(e) => setDays(IDLE_DAYS_CHOICES.find((d) => String(d) === e.target.value) ?? DEFAULT_IDLE_DAYS)}
          >
            {IDLE_DAYS_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "1 day" : `${d} days`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {candidates.length === 0 ? (
        <p className="text-muted-foreground text-xs">No task without a running session has been idle that long.</p>
      ) : (
        <>
          <p className="text-muted-foreground max-w-prose text-xs">
            Removing a worktree ends its task and keeps its branch with every commit, as “End task” with the branch kept. Files git ignores
            (dependencies, build output) go with it.
          </p>
          <ul className="flex flex-col gap-1">
            {candidates.map((worktree) => (
              <CleanupRow
                key={worktree.task}
                worktree={worktree}
                size={sizes.get(worktree.task)}
                checked={selected.has(worktree.task)}
                onToggle={() => toggle(worktree.task)}
              />
            ))}
          </ul>
          {confirming ? (
            <div role="alertdialog" aria-label="Remove work too" className="flex flex-col gap-2">
              <p className="text-warning text-sm">
                Warning: removing these also deletes work their branches do not hold:{" "}
                {lossy.map((w) => `${w.branch} (${lossLabel(w)})`).join("; ")}. This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={() => void remove()}>
                  Remove anyway
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={running || selected.size === 0}
                onClick={() => (lossy.length > 0 ? setConfirming(true) : void remove())}
              >
                <Trash2 /> {running ? "Removing…" : `Remove ${selected.size === 1 ? "1 worktree" : `${selected.size} worktrees`}`}
              </Button>
            </div>
          )}
        </>
      )}
      {ended.length > 0 && <EndedList ended={ended} />}
    </section>
  );
}

function CleanupRow({
  worktree,
  size,
  checked,
  onToggle,
}: {
  worktree: TaskWorktree;
  size: TaskWorktreeSize | string | undefined;
  checked: boolean;
  onToggle: () => void;
}) {
  const loss = lossLabel(worktree);
  return (
    <li>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary mt-1 size-4 shrink-0"
          checked={checked}
          disabled={!removable(worktree)}
          onChange={onToggle}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            <span className="font-mono">{worktree.branch}</span>
            <span className="text-muted-foreground">{` · ${worktree.repo} · last active ${relativeTime(worktree.lastActivityAt, new Date())}`}</span>
            <span className="text-muted-foreground">{` · ${sizeLabel(size)}`}</span>
          </span>
          {loss && removable(worktree) && <span className="text-warning text-xs">{`Would delete ${loss}`}</span>}
          {!removable(worktree) && <span className="text-warning text-xs">{`${loss}; end it from its task panel`}</span>}
        </span>
      </label>
    </li>
  );
}

function sizeLabel(size: TaskWorktreeSize | string | undefined): string {
  if (size === undefined) return "measuring…";
  if (typeof size === "string") return "size unknown";
  return size.complete ? formatBytes(size.bytes) : `over ${formatBytes(size.bytes)}`;
}

function EndedList({ ended }: { ended: readonly Ended[] }) {
  const removed = ended.filter((e) => e.problem === null).length;
  return (
    <div role="status" className="flex flex-col gap-1 text-xs" aria-label="Cleanup result">
      <p>{removed === 1 ? "Removed 1 worktree." : `Removed ${removed} worktrees.`}</p>
      {ended
        .filter((e) => e.problem !== null)
        .map((e) => (
          <p key={e.task} className="text-destructive">{`${e.branch}: ${e.problem}`}</p>
        ))}
    </div>
  );
}

/**
 * The size of each candidate's worktree, measured one after another, since each one counts every file; an error is its
 * text. A task no longer a candidate is dropped.
 */
function useWorktreeSizes(conn: Connection, candidates: readonly TaskWorktree[]): Map<string, TaskWorktreeSize | string> {
  const [sizes, setSizes] = useState(new Map<string, TaskWorktreeSize | string>());
  // The effect's key: the same tasks in a new list (a reload) are not measured again.
  const taskIdsKey = candidates.map((w) => w.task).join("\0");
  useEffect(() => {
    const tasks = taskIdsKey === "" ? [] : taskIdsKey.split("\0");
    let cancelled = false;
    setSizes((before) => new Map([...before].filter(([task]) => tasks.includes(task))));
    const measure = async () => {
      for (const task of tasks) {
        if (cancelled) return;
        const size = await post(conn, agentsApi.taskWorktreeSize, { task }).catch((err: unknown) => errorMessage(err));
        if (!cancelled) setSizes((before) => new Map(before).set(task, size));
      }
    };
    void measure();
    return () => {
      cancelled = true;
    };
  }, [conn, taskIdsKey]);
  return sizes;
}
