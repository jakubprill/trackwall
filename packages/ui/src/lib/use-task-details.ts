import { agentsApi, miseApi, type RunningMiseTask, type Task, type TaskMessage, type TaskMiseConfig } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { RUNNING_MISE_POLL_MS } from "./run-state.ts";
import { taskName } from "./session-entries.ts";
import { type TaskNoticeInput, taskNotices } from "./task-notices.ts";
import { type Remote, useRemote } from "./use-remote.ts";
import { useTaskMergeRequest } from "./use-task-merge-request.ts";
import { useTaskVerification } from "./use-task-verification.ts";

/** An agent changes files within seconds, but a warning need not be instant, and the shared files read git of every task in the repo. */
const WARNING_POLL_MS = 5000;

/**
 * What the sections above a task's terminal show (ADR-91), loaded once for the task panel or a grid tile, together with
 * the notices that sum them up. The sections take their data from here, so the strip, the badge and the sections never
 * disagree. A failed check of the shared files shows no warning, since it may no longer be true; a failed check of the
 * mise config warns only when mise cannot run in the worktree at all (ADR-59). A grid tile calls it for every entry,
 * so without a task (a session in a repo root, task proposals) it loads nothing and has no notices.
 */
export function useTaskDetails({
  conn,
  task,
  tasks,
  messages,
  runningLive,
  paused,
  warningPollMs = WARNING_POLL_MS,
}: {
  conn: Connection;
  task: Task | undefined;
  /** All tasks on the list, to name the other task of shared files. */
  tasks: readonly Task[];
  /** The messages the task's proposer sent its session (ADR-68), oldest first. */
  messages: readonly TaskMessage[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  /** While the task is being ended, nothing is loaded. */
  paused: boolean;
  /** How often the two warnings are checked; a grid tile that is not selected checks less often, since each check reads git. */
  warningPollMs?: number;
}) {
  const id = task?.id ?? "";
  const off = paused || task === undefined;
  const verification = useTaskVerification(conn, id, off);
  const mergeRequest = useTaskMergeRequest(conn, id, off);
  const loadShared = useCallback(() => post(conn, agentsApi.taskSharedFiles, { task: id }), [conn, id]);
  const shared = useRemote(off ? undefined : loadShared, { pollMs: warningPollMs });
  const loadMiseConfig = useCallback(() => post(conn, agentsApi.taskMiseConfig, { task: id }), [conn, id]);
  const miseConfig = useRemote(off ? undefined : loadMiseConfig, { pollMs: warningPollMs });
  const loadRunning = useCallback(() => post(conn, miseApi.running, {}), [conn]);
  const running = useRemote(off ? undefined : loadRunning, { pollMs: RUNNING_MISE_POLL_MS, live: runningLive });

  const sharedFiles = (shared.error ? [] : (shared.data?.shared ?? [])).flatMap(({ task: other, files }) => {
    const found = tasks.find((t) => t.id === other);
    return found ? [{ files, other: found }] : [];
  });
  // A run the verification section shows with its log and Cancel is left out of the mise tasks, so it is not listed twice.
  const miseRuns = (running.data ?? []).filter((r) => r.task === id && r.miseTask !== verification.runningMiseTask);
  const mergeRequestShown = (mergeRequest.state?.push?.commits ?? 0) > 0;
  const notices = !task
    ? []
    : taskNotices({
        task,
        messages,
        sharedWith: sharedFiles.map(({ files, other }) => ({ task: other.id, name: taskName(other), files: files.length })),
        miseConfig: shownMiseConfig(miseConfig),
        verification: verification.verification,
        mergeRequest: mergeRequestShown,
        miseRuns: miseRuns.map((r) => r.miseTask),
      });
  return {
    verification,
    mergeRequest,
    sharedFiles,
    miseConfig,
    miseRuns,
    messages,
    notices,
    /** Both warnings have been checked once, so a warning that shows up later is new. */
    warningsChecked: isChecked(shared) && isChecked(miseConfig),
  };
}

/** The mise config for its notice: `unavailable` when mise cannot run in the worktree, nothing after another failure. */
function shownMiseConfig(remote: Remote<TaskMiseConfig>): TaskNoticeInput["miseConfig"] {
  if (remote.errorCode === "mise_unavailable") return "unavailable";
  return remote.error ? undefined : remote.data;
}

function isChecked(remote: { data?: unknown; error?: string }): boolean {
  return remote.data !== undefined || remote.error !== undefined;
}

export type TaskDetails = ReturnType<typeof useTaskDetails>;
