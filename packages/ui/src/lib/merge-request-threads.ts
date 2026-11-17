import { MERGE_REQUEST_THREADS_MAX, type MergeRequestThread, type MergeRequestThreads } from "@trackwall/protocol";

/**
 * The unresolved threads of a task's merge request in its panel (ADR-255): where each one is, which the user hands to
 * the agent at first, and what the list leaves out, in words.
 */

/** Where a thread is: a line (a removed one says so), a whole file, or the merge request as a whole. */
export function threadPlace(thread: MergeRequestThread): string {
  if (thread.file === null) return "the merge request";
  if (thread.line === null) return thread.file;
  const place = `${thread.file}:${thread.line.number}`;
  return thread.line.side === "old" ? `${place} (removed line)` : place;
}

/** The threads picked at first: all of them, up to the most the agent takes at once. */
export function firstPicks(threads: readonly MergeRequestThread[]): Set<string> {
  return new Set(threads.slice(0, MERGE_REQUEST_THREADS_MAX).map((t) => t.id));
}

/** Why "Send to agent" cannot go now, or `null` when it can. */
export function sendBlocker(picked: number): string | null {
  if (picked === 0) return "Pick a thread to send.";
  if (picked > MERGE_REQUEST_THREADS_MAX) return `The agent takes at most ${MERGE_REQUEST_THREADS_MAX} threads at once.`;
  return null;
}

/** What the list says above the threads: how many, or that there are none, and that the repo host has more. */
export function threadsSummary(read: MergeRequestThreads): string {
  const count = read.threads.length;
  const shown = count === 0 ? "No unresolved threads." : `${count} unresolved ${count === 1 ? "thread" : "threads"}.`;
  return read.more ? `${shown} The merge request has more than Trackwall reads: open it for the rest.` : shown;
}
