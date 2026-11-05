import { agentsApi, type Session, workspaceApi } from "@trackwall/protocol";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * A running session's restart on another model (ADR-206). The supervisor runs on `supervisorModel` from Settings
 * (ADR-193), which it reads at every start, so for it the model is saved there first; any other session restarts with
 * the model, which a task keeps for its later resumes.
 */
export async function restartOnModel(
  conn: Connection,
  session: Pick<Session, "id" | "supervisor">,
  model: string | null,
): Promise<Session> {
  if (!session.supervisor) return post(conn, agentsApi.restart, { session: session.id, model });
  await post(conn, workspaceApi.setSupervisorModel, { model });
  return post(conn, agentsApi.restart, { session: session.id });
}

/** What a restart on another model does to the session, under the model field. */
export function restartOnModelNote(session: Pick<Session, "supervisor" | "task">): string {
  const keeps = session.supervisor
    ? "It becomes the supervisor model in Settings."
    : session.task !== null
      ? "The task keeps it for its later resumes."
      : "The session keeps it for its later restarts.";
  return `The session stops and starts again on this model with the same conversation. ${keeps}`;
}
