import type { ReadRequest, ReadRequestHold, Session } from "@trackwall/protocol";

/**
 * What the session panel says about a read request (ADR-159): why the agent has not read what waits for it, and whether
 * Deliver now helps. Only where nothing would send it (`idle`): everywhere else the daemon sends it on its own, and a
 * click could only send it twice.
 */
const HOLDS: Record<ReadRequestHold, { text: string; canDeliver: boolean }> = {
  sent: { text: "Sent to the agent, which has not read it yet", canDeliver: false },
  pending: { text: "Goes to the agent as soon as it can take it", canDeliver: false },
  user_text: { text: "Waits for the text in the input box: send it or clear it", canDeliver: false },
  dialog: { text: "Waits until the agent's question is answered", canDeliver: false },
  idle: { text: "Nothing sends it until the next message", canDeliver: true },
};

export function readRequestHold(request: ReadRequest): { text: string; canDeliver: boolean } {
  return HOLDS[request.waitsFor];
}

/** The read request of a session that runs, for the strip; `null` hides it. */
export function shownReadRequest(session: Session | undefined): ReadRequest | null {
  return session?.run.kind === "running" ? session.readRequest : null;
}
