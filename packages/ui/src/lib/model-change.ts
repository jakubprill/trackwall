import { modelSwitch, type Session } from "@trackwall/protocol";

/** What a restart on another model (ADR-206) does to the session, under the model field: who keeps the model after it. */
export function restartOnModelNote(session: Pick<Session, "supervisor" | "task">): string {
  const keeps = session.supervisor
    ? "It becomes the supervisor model in Settings."
    : session.task !== null
      ? "The task keeps it for its later resumes."
      : "The session keeps it for its later restarts.";
  return `The session stops and starts again on this model with the same conversation. ${keeps}`;
}

/**
 * The strip of a session that runs on another model than Trackwall started it on (ADR-225): Copilot CLI falls back
 * without stopping when the account does not offer the model, and `/model` switches it, so only its event log tells.
 * `null` when there is nothing to say (`modelSwitch`).
 */
export function modelSwitchNote(session: Pick<Session, "model" | "modelInUse">): { title: string; detail: string } | null {
  const switched = modelSwitch(session);
  if (switched === null) return null;
  return {
    title: `Runs on ${switched.inUse}, not ${switched.requested}`,
    detail:
      `Copilot CLI took another model without stopping: your account may not offer ${switched.requested}, or /model ` +
      "switched it. Model restarts the session on the one you choose.",
  };
}
