import type { RunningMiseTask, SessionList } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";
import { runStateLabel } from "./run-state.ts";
import { latestSession, type SessionSelection, taskName } from "./session-entries.ts";
import { PROPOSAL_STATUS, sessionStateLabel, sessionTitle } from "./session-state.ts";

/**
 * What is going on in one repo, for the bar above the repo's tabs (ADR-103): task proposals waiting for a decision,
 * sessions in the repo root, tasks and running mise tasks. Each item opens where its work is: a proposal, session or
 * task in "Sessions", a mise task of the repo root in the repo's "mise tasks" tab, and one in a task's worktree at that
 * task. The states are the words of the "Sessions" view and the "mise tasks" tab.
 */
export interface RepoActivityItem {
  /** React key, unique among the items of one repo. */
  key: string;
  kind: "proposal" | "session" | "task" | "mise";
  name: string;
  status: { tone?: StatusTone; label: string };
  open: RepoActivityTarget;
}

export type RepoActivityTarget = { view: "sessions"; selection: NonNullable<SessionSelection> } | { view: "mise" };

/**
 * Proposals first, then what waits for you, then the rest of the sessions and tasks newest first (the daemon's order),
 * then mise tasks. A session in the repo root that has ended is left out: its work is over and it stays only until the
 * user closes it in "Sessions". A task stays with or without a session, because its worktree is still work in the repo.
 */
export function repoActivity(repo: string, list: SessionList | undefined, running: readonly RunningMiseTask[]): RepoActivityItem[] {
  const work = list ? [...rootSessions(repo, list), ...tasks(repo, list)] : [];
  return [
    ...(list ? proposals(repo, list) : []),
    ...work.filter((w) => w.waits).map((w) => w.item),
    ...work.filter((w) => !w.waits).map((w) => w.item),
    ...running.filter((t) => t.repo === repo).map(miseItem),
  ];
}

/** A session or task with whether it waits for you, which puts it ahead of the rest. */
interface Work {
  item: RepoActivityItem;
  waits: boolean;
}

function proposals(repo: string, list: SessionList): RepoActivityItem[] {
  return list.proposals
    .filter((p) => p.repo === repo)
    .map((p) => ({
      key: `proposal:${p.id}`,
      kind: "proposal",
      name: p.title,
      status: PROPOSAL_STATUS,
      open: { view: "sessions", selection: { kind: "proposal", id: p.id } },
    }));
}

function rootSessions(repo: string, list: SessionList): Work[] {
  return list.sessions
    .filter((s) => s.repo === repo && s.task === null && s.run.kind !== "exited")
    .map((session) => ({
      waits: session.needsAttention,
      item: {
        key: `session:${session.id}`,
        kind: "session",
        name: sessionTitle(session),
        status: sessionStateLabel(session),
        open: { view: "sessions", selection: { kind: "session", id: session.id } },
      },
    }));
}

function tasks(repo: string, list: SessionList): Work[] {
  return list.tasks
    .filter((t) => t.repo === repo)
    .map((task) => {
      const session = latestSession(list.sessions, task.id);
      return {
        waits: session?.needsAttention ?? false,
        item: {
          key: `task:${task.id}`,
          kind: "task",
          name: taskName(task),
          status: session ? sessionStateLabel(session) : { label: "no session" },
          open: { view: "sessions", selection: { kind: "task", id: task.id } },
        },
      };
    });
}

function miseItem(t: RunningMiseTask): RepoActivityItem {
  return {
    key: `mise:${t.task ?? "root"}:${t.miseTask}`,
    kind: "mise",
    name: t.task === null ? t.miseTask : `${t.miseTask} (in a task)`,
    status: runStateLabel(t.run),
    open: t.task === null ? { view: "mise" } : { view: "sessions", selection: { kind: "task", id: t.task } },
  };
}
