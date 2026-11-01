import type { ReadRequest, ReadRequestHold, Session } from "@trackwall/protocol";

/**
 * What the session panel says about what waits unread for the session's agent (ADR-159): why the daemon's prompt has
 * not been read yet, and whether Deliver now can help. It cannot in the middle of a turn, where the prompt already goes
 * with the next tool's result or the turn's end.
 */
const HOLDS: Record<ReadRequestHold, { text: string; canDeliver: boolean }> = {
  sent: { text: "Sent to the agent, which has not read it yet", canDeliver: true },
  turn_end: { text: "Goes to the agent with its next tool call or when its turn ends", canDeliver: false },
  user_text: { text: "Waits for your text in the input box: send it or clear it", canDeliver: true },
  dialog: { text: "Waits until the agent's question is answered", canDeliver: false },
  deliver_now: { text: "Nothing sends it until the next message; deliver it now", canDeliver: true },
};

export function readRequestHold(request: ReadRequest): { text: string; canDeliver: boolean } {
  return HOLDS[request.waitsFor];
}

/** The read request of a session that runs, for the strip; `null` hides it. */
export function shownReadRequest(session: Session | undefined): ReadRequest | null {
  return session?.run.kind === "running" ? session.readRequest : null;
}
