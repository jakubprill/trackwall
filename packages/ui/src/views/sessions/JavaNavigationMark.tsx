import { agentsApi, type Task } from "@trackwall/protocol";
import { useCallback } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { javaNavigationMark, javaNavigationPollMs } from "@/lib/java-navigation";
import { useRemote } from "@/lib/use-remote";

/** How a running task's Java language server is doing (ADR-124), in the task's header; nothing for a task without it. */
export function JavaNavigationMark({ conn, task, running }: { conn: Connection; task: Task; running: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskJavaNavigation, { task: task.id }), [conn, task.id]);
  const status = useRemote(task.javaNavigation && running ? load : undefined, { pollMs: javaNavigationPollMs });
  if (!status.data) return null;
  const mark = javaNavigationMark(status.data);
  return (
    <span className="shrink-0 text-xs" title={mark.title}>
      <StatusLabel tone={mark.tone} label={mark.label} />
    </span>
  );
}
