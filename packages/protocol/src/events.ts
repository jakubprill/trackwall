import { z } from "zod";
import { SessionList } from "./agents.ts";
import { RunningMiseTask } from "./mise.ts";

/**
 * Daemon events on the WebSocket `/ws` (§5.2, ADR-36). An event carries the whole snapshot of one topic (the session list,
 * running mise tasks), not a difference: a client that connects or reconnects first gets the snapshot of every topic, so it
 * needs no event buffer and no `resync`. The daemon sends an event only when a topic's snapshot has changed. One ordered
 * connection gives the order, so an event has no number. The client sends nothing.
 */

/** The client does not keep up with events (too much in the daemon's buffer); it reconnects and starts from the snapshots. */
export const EVENTS_CLOSE_SLOW = 4429;

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The list of sessions and tasks, the same as `agents/sessions` (§4.4). */
  z.object({ type: z.literal("sessions.changed"), payload: SessionList }),
  /** Running mise tasks of all repos, the same as `mise/running` (§4.7). */
  z.object({ type: z.literal("mise.running.changed"), payload: z.array(RunningMiseTask) }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;
export type DaemonEventType = DaemonEvent["type"];
/** An event of the given type. */
export type DaemonEventOf<T extends DaemonEventType> = Extract<DaemonEvent, { type: T }>;
/** The topic snapshot of an event of the given type. */
export type DaemonEventPayload<T extends DaemonEventType> = DaemonEventOf<T>["payload"];
