import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useProviderModels } from "@/lib/use-provider-models";
import { useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

/**
 * The retry model (ADR-232): the stronger Copilot CLI model a task whose verification failed is offered to be retried
 * on, so the retry is one click in the task's Verification section.
 */
export function RetryModelSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const { models } = useProviderModels(conn);

  async function save(model: string | null) {
    await post(conn, workspaceApi.setRetryModel, { model });
    settings.reload();
  }

  const data = settings.data;
  return (
    <Surface label="Retry model">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The stronger Copilot CLI model, written as Copilot CLI's /model lists it, that a task whose verification failed is offered to be
          retried on. The retry is a new task with the same prompt from the same commit, so you can compare the two attempts and keep the
          better one. Without it, the retry asks for the model each time.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <PathForm
            key={data.retryModel ?? ""}
            label="Retry model"
            placeholder="claude-opus-5.5"
            configKey="retryModel"
            initialPath={data.retryModel ?? ""}
            configFile={data.configFile}
            folder={false}
            suggestions={models}
            save={save}
            resetLabel="None"
            reset={data.retryModel === null && !data.retryModelProblem ? undefined : () => save(null)}
          />
        )}
        {data?.retryModelProblem && <p className="text-destructive text-xs break-words">{data.retryModelProblem}</p>}
      </div>
    </Surface>
  );
}
