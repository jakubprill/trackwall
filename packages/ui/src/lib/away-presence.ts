import { z } from "zod";

/**
 * Whether the user was away from Trackwall (ADR-151): no key, click, scroll or pointer move in any window of this origin
 * for `AWAY_AFTER_MS`. The first sign of the user after such a gap opens an absence, which "While you were away" shows
 * until the user dismisses it; an absence not dismissed yet grows with the next one, so nothing that happened in
 * between drops out. Kept in `localStorage`, which every window and tab of one origin shares, so all of them agree on
 * one absence and a dismissal in one clears it in the others. Storage can be missing or refuse access (a private
 * window, blocked site data): then the window keeps its own memory, and a write that fails is forgotten.
 */

/** No sign of the user for this long is an absence: a meeting or a lunch, not a look at another window. */
export const AWAY_AFTER_MS = 15 * 60_000;

/** The last sign of the user is written at most this often; a gap is measured from it, so it is this much too long at most. */
export const PRESENCE_WRITE_MS = 30_000;

export const LAST_ACTIVE_KEY = "trackwall.presence.last-active";
export const AWAY_KEY = "trackwall.presence.away";

/** From the user's last sign before the gap to their first after it, ISO 8601. */
export const AwayPeriod = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });
export type AwayPeriod = z.infer<typeof AwayPeriod>;

/**
 * The absence the user's sign at `now` opens: `undefined` when the last sign was less than `AWAY_AFTER_MS` ago or is
 * not known. An absence not dismissed yet keeps its start, so the new one covers both.
 */
export function absenceAt(lastActive: number | undefined, now: number, open: AwayPeriod | undefined): AwayPeriod | undefined {
  if (lastActive === undefined || now - lastActive < AWAY_AFTER_MS) return undefined;
  return { from: open?.from ?? new Date(lastActive).toISOString(), to: new Date(now).toISOString() };
}

type Storage = () => Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function readLastActive(storage: Storage): number | undefined {
  try {
    const value = Number(storage().getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastActive(storage: Storage, at: number): void {
  try {
    storage().setItem(LAST_ACTIVE_KEY, String(at));
  } catch {
    // This window still remembers it; the others measure from their own.
  }
}

/** The absence another window wrote, read with a schema, since anything on this origin may have written the key. */
export function readAway(storage: Storage): AwayPeriod | undefined {
  try {
    const text = storage().getItem(AWAY_KEY);
    if (text === null) return undefined;
    const parsed = AwayPeriod.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the absence, or with `undefined` clears it (the user dismissed it). */
export function saveAway(storage: Storage, away: AwayPeriod | undefined): void {
  try {
    if (away === undefined) storage().removeItem(AWAY_KEY);
    else storage().setItem(AWAY_KEY, JSON.stringify(away));
  } catch {
    // Only this window shows or dismisses it then.
  }
}
