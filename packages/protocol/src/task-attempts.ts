/**
 * The attempts at one task (ADR-251): a task and its retries (ADR-233), linked by `retryOf`, which all start from the
 * same prompt and base commit, so the user can compare them side by side and keep one. One rule for the daemon, which
 * checks the attempt a user keeps, and the UI, which offers the comparison.
 */

/** What the rule reads of a task: its id and the task it retries. */
interface Attempt {
  id: string;
  retryOf: string | null;
}

/**
 * The id of the first attempt `task` goes back to through `retryOf`, following only the listed `tasks`: a retry of an
 * ended task goes back to that task's id, which is no longer listed. A cycle, which no daemon writes, stops where it
 * closes.
 */
export function firstAttempt(task: Attempt, tasks: readonly Attempt[]): string {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let current = task;
  while (current.retryOf !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const earlier = byId.get(current.retryOf);
    if (earlier === undefined) return current.retryOf;
    current = earlier;
  }
  return current.id;
}

/** The listed tasks other than `task` that are attempts at the same task, in the order of `tasks`. */
export function otherAttempts<T extends Attempt>(task: Attempt, tasks: readonly T[]): T[] {
  const first = firstAttempt(task, tasks);
  return tasks.filter((t) => t.id !== task.id && firstAttempt(t, tasks) === first);
}
