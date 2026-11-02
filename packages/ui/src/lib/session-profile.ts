import type { Session, SessionList } from "@trackwall/protocol";
import { createContext, useContext } from "react";

/**
 * A running session keeps the session profile it started with (ADR-136), since Copilot CLI reads its environment once,
 * while new sessions take the one set in Settings now. When the two differ, the session still talks to the model
 * provider of the old profile, so its panel, its grid tile and Settings say so (ADR-178). The comparison uses only the
 * profile's name, so it needs no mise run and shows even when mise is slow or fails.
 */

/** The profile sessions start with now, from the session list; `null` while `workspace.yaml` cannot be read or before the list came. */
export const CurrentSessionProfile = createContext<SessionList["sessionProfile"]>(null);

/** The value of `CurrentSessionProfile` for the session list as it is (`undefined` before it came). */
export function currentSessionProfile(list: SessionList | undefined): SessionList["sessionProfile"] {
  return list === undefined ? null : list.sessionProfile;
}

export function useCurrentSessionProfile(): SessionList["sessionProfile"] {
  return useContext(CurrentSessionProfile);
}

/**
 * What a running session should say about its profile: e.g. "Started with no profile; sessions now start with profile
 * byok". `null` when the session runs with the current profile, is not running (its next start takes the current one),
 * or the current one is not known.
 */
export function profileChange(session: Session | undefined, current: SessionList["sessionProfile"]): string | null {
  if (session?.run.kind !== "running" || current === null) return null;
  const started = session.environment.profile;
  if (started === current.name) return null;
  return `Started with ${profileName(started)}; sessions now start with ${profileName(current.name)}`;
}

/** The running sessions that started with another profile than new sessions get now. */
export function sessionsOnOtherProfile(list: SessionList): Session[] {
  return list.sessions.filter((session) => profileChange(session, list.sessionProfile) !== null);
}

function profileName(profile: string | null): string {
  return profile === null ? "no profile" : `profile ${profile}`;
}
