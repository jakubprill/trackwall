import type { SessionList, Task } from "@trackwall/protocol";
import { useMemo, useState } from "react";
import { type SessionRow, sessionRows } from "./session-entries.ts";
import { actionIsNewer, type RemoteHandle } from "./use-remote.ts";

/** The rows of the Sessions list and their tasks, shared by the list and the supervisor panel. */
export interface SessionTree {
  tasks: Task[];
  rows: SessionRow[];
  /** Hides a task the user has just ended until a list loaded after that arrives; several can be hidden at once. */
  hideTask: (task: string) => void;
}

/**
 * An ended task disappears at once, not at the next list load, so that its panel does not come back without its
 * worktree; the same tasks feed the tree, the task panel and the supervisor's "Delegated".
 */
export function useSessionTree(sessions: RemoteHandle<SessionList>): SessionTree {
  const [removed, setRemoved] = useState<readonly { task: string; afterLoad: number }[]>([]);
  // The hidden ids as one string, so that the rows below are rebuilt only when the hidden set itself changes.
  const hiddenKey = removed
    .filter((r) => actionIsNewer(r.afterLoad, sessions.loadNumber))
    .map((r) => r.task)
    .join(" ");
  const { data } = sessions;
  const visible = useMemo(() => {
    if (!data) return { tasks: [], rows: [] };
    const hidden = new Set(hiddenKey.split(" "));
    const tasks = data.tasks.filter((t) => !hidden.has(t.id));
    return { tasks, rows: sessionRows({ ...data, tasks }) };
  }, [data, hiddenKey]);
  const hideTask = (task: string) => {
    const afterLoad = sessions.sentLoads();
    // Hides that a newer list already covers are dropped, so the list does not grow for the life of the view.
    setRemoved((all) => [...all.filter((r) => actionIsNewer(r.afterLoad, sessions.loadNumber)), { task, afterLoad }]);
  };
  return { ...visible, hideTask };
}
