import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

/**
 * The supervisor's model (ADR-193): a Copilot CLI model id the supervisor runs on from its next start, resume or restart,
 * such as a cheaper one than the default, since it mostly reads and proposes tasks, which run on their own model.
 */
export function SupervisorModelSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

  async function save(model: string | null) {
    await post(conn, workspaceApi.setSupervisorModel, { model });
    settings.reload();
  }

  const data = settings.data;
  return (
    <Surface label="Supervisor model">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The Copilot CLI model the supervisor runs on, written as Copilot CLI's /model lists it, such as a cheaper one than your default:
          the supervisor mostly reads and proposes tasks, and each task runs on its own model. It applies from the supervisor's next start
          or restart, in the terminal and in Chat. Copilot CLI's default goes back to the model every other session gets.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <PathForm
            key={data.supervisorModel ?? ""}
            label="Supervisor model"
            placeholder="gpt-5-mini"
            configKey="supervisorModel"
            initialPath={data.supervisorModel ?? ""}
            configFile={data.configFile}
            folder={false}
            save={save}
            resetLabel="Copilot CLI's default"
            reset={data.supervisorModel === null && !data.supervisorModelProblem ? undefined : () => save(null)}
          />
        )}
        {data?.supervisorModelProblem && <p className="text-destructive text-xs break-words">{data.supervisorModelProblem}</p>}
      </div>
    </Surface>
  );
}
