import {
  MERGE_REQUEST_THREADS_MAX,
  type MergeRequestThread,
  type MergeRequestThreads,
  type SeenMergeRequestThread,
} from "@trackwall/protocol";

/**
 * The unresolved threads of a task's merge request in its panel (ADR-256): where each one is, which the user hands to
 * the agent, and what the list leaves out, in words.
 */

/** Where a thread is: a line (a removed one says so), a whole file, or the merge request as a whole. */
export function threadPlace(thread: MergeRequestThread): string {
  if (thread.file === null) return "the merge request";
  if (thread.line === null) return thread.file;
  const place = `${thread.file}:${thread.line.number}`;
  return thread.line.side === "old" ? `${place} (removed line)` : place;
}

/**
 * What "Send to agent" hands over: each picked thread with the notes the user sees, in the list's order, so the daemon can
 * refuse a thread that changed since. Nothing is picked at first: a thread's words come from other people, and the user
 * reads each before it goes.
 */
export function pickedThreads(threads: readonly MergeRequestThread[], picked: ReadonlySet<string>): SeenMergeRequestThread[] {
  return threads.filter((t) => picked.has(t.id)).map(({ id, notes }) => ({ id, notes }));
}

/** What a thread says under its notes: the replies on the repo host that Trackwall neither shows nor sends. */
export function notesLeftOut(thread: MergeRequestThread): string | null {
  if (thread.moreNotes === 0) return null;
  const replies = thread.moreNotes === 1 ? "1 later reply" : `${thread.moreNotes} later replies`;
  return `${replies} only on the repo host, not sent to the agent`;
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
