import { agentsApi, type Task, workspaceApi } from "@trackwall/protocol";
import { RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { ModelChangeStrip } from "@/components/ModelChange";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { oneClickRetryModel } from "@/lib/task-retry";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The retry of a task whose verification failed on a stronger model (ADR-232): a new task with the same prompt from the
 * same commit on another model, linked to this one, which the panel then opens. With a retry model in Settings it is one
 * click; "Other model" or no retry model opens the model field.
 */
export function TaskRetry({ conn, task, onRetried }: { conn: Connection; task: Task; onRetried: (task: string) => void }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const [choosing, setChoosing] = useState(false);
  const retry = (model: string | null) => post(conn, agentsApi.retryTask, { task: task.id, model });
  const done = (retried: Task) => onRetried(retried.id);
  const oneClick = useAction(retry, done);
  const model = oneClickRetryModel(task, settings.data?.retryModel ?? null);

  if (choosing)
    return (
      <ModelChangeStrip
        conn={conn}
        current={task.model}
        initial={model}
        verb="Retry"
        note="A new task with the same prompt from the same commit on this model. This task stays as it is, so you can compare the two."
        apply={retry}
        onDone={done}
        onCancel={() => setChoosing(false)}
      />
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {model !== null && (
        <Button variant="outline" size="sm" onClick={() => oneClick.run(model)} disabled={oneClick.pending}>
          <RotateCcw /> Retry on {model}
        </Button>
      )}
      <Button variant={model === null ? "outline" : "ghost"} size="sm" onClick={() => setChoosing(true)} disabled={oneClick.pending}>
        {model === null && <RotateCcw />} {model === null ? "Retry on a stronger model" : "Other model"}
      </Button>
      {oneClick.error && <span className="text-destructive text-xs break-words">{oneClick.error}</span>}
    </div>
  );
}
