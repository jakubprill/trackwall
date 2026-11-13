import { elapsedLabel } from "./format.ts";

/**
 * How long a session has waited for you (ADR-247), beside its state wherever the UI shows it: "12 min" from the
 * daemon's `Session.waitingSince`. Nothing in the first minute, when the state says enough, and nothing while the
 * session does not wait (`null`).
 */
export function waitingLabel(waitingSince: string | null, now: Date): string | undefined {
  if (waitingSince === null) return undefined;
  const label = elapsedLabel(waitingSince, now);
  return label === "" || label === "just now" ? undefined : label;
}

/** The tooltip of the waiting time: since when, in the user's own clock, with the day when it is not today. */
export function waitingSinceTitle(waitingSince: string, now: Date): string {
  const at = new Date(waitingSince);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `Waiting for you since ${time}`;
  return `Waiting for you since ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
