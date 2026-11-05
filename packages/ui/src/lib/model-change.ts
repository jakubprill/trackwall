import type { Session } from "@trackwall/protocol";

/** What a restart on another model (ADR-206) does to the session, under the model field: who keeps the model after it. */
export function restartOnModelNote(session: Pick<Session, "supervisor" | "task">): string {
  const keeps = session.supervisor
    ? "It becomes the supervisor model in Settings."
    : session.task !== null
      ? "The task keeps it for its later resumes."
      : "The session keeps it for its later restarts.";
  return `The session stops and starts again on this model with the same conversation. ${keeps}`;
}
