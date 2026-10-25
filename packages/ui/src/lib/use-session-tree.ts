import type { SessionList, Task } from "@trackwall/protocol";
import { useMemo, useState } from "react";
import { type SessionRow, sessionRows } from "./session-entries.ts";
import { actionIsNewer, type RemoteHandle } from "./use-remote.ts";

/** The rows of the Sessions list and their tasks, shared by the list and the supervisor panel. */
export interface SessionTree {
  tasks: Task[];
  rows: SessionRow[];
  /** Hides a task the user has just ended until a list loaded after that arrives. */
  hideTask: (task: string) => void;
}

/**
 * An ended task disappears at once, not at the next list load, so that its panel does not come back without its
 * worktree; the same tasks feed the tree, the task panel and the supervisor's "Delegated".
 */
export function useSessionTree(sessions: RemoteHandle<SessionList>): SessionTree {
  const [removed, setRemoved] = useState<{ task: string; afterLoad: number }>();
  const hidden = removed && actionIsNewer(removed.afterLoad, sessions.loadNumber) ? removed.task : undefined;
  const { data } = sessions;
  const visible = useMemo(() => {
    if (!data) return { tasks: [], rows: [] };
    const tasks = data.tasks.filter((t) => t.id !== hidden);
    return { tasks, rows: sessionRows({ ...data, tasks }) };
  }, [data, hidden]);
  return { ...visible, hideTask: (task) => setRemoved({ task, afterLoad: sessions.sentLoads() }) };
}
