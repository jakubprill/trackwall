import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { RemoteHandle } from "@/lib/use-remote";
import { ModelSettingSurface } from "./ModelSettingSurface.tsx";

/**
 * The supervisor's model (ADR-193): a Copilot CLI model id the supervisor runs on from its next start, resume or restart,
 * such as a cheaper one than the default, since it mostly reads and proposes tasks, which run on their own model.
 */
export function SupervisorModelSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  return (
    <ModelSettingSurface
      conn={conn}
      settings={settings}
      label="Supervisor model"
      description="The Copilot CLI model the supervisor runs on, written as Copilot CLI's /model lists it, such as a cheaper one than your default: the supervisor mostly reads and proposes tasks, and each task runs on its own model. It applies from the supervisor's next start or restart, in the terminal and in Chat. Copilot CLI's default goes back to the model every other session gets."
      placeholder="gpt-5-mini"
      configKey="supervisorModel"
      resetLabel="Copilot CLI's default"
      read={(s) => ({ model: s.supervisorModel, problem: s.supervisorModelProblem })}
      save={(model) => post(conn, workspaceApi.setSupervisorModel, { model })}
    />
  );
}
