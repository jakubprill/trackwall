import { workspaceApi } from "@trackwall/protocol";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { ModelSettingSurface } from "./ModelSettingSurface.tsx";

/**
 * The retry model (ADR-232): the stronger Copilot CLI model a task whose verification failed is offered to be retried
 * on, so the retry is one click in the task's Verification section.
 */
export function RetryModelSurface({ conn }: { conn: Connection }) {
  return (
    <ModelSettingSurface
      conn={conn}
      label="Retry model"
      description="The stronger Copilot CLI model, written as Copilot CLI's /model lists it, that a task whose verification failed is offered to be retried on. The retry is a new task with the same prompt from the same commit, so you can compare the two attempts and keep the better one. Without it, the retry asks for the model each time."
      placeholder="claude-opus-5.5"
      configKey="retryModel"
      resetLabel="None"
      read={(s) => ({ model: s.retryModel, problem: s.retryModelProblem })}
      save={(model) => post(conn, workspaceApi.setRetryModel, { model })}
    />
  );
}
