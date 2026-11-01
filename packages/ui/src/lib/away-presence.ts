import { z } from "zod";

/**
 * Whether the user was away from Trackwall (ADR-151): no key, click, scroll or pointer move in any window of this origin,
 * and none brought to the front, for `AWAY_AFTER_MS`. The first sign of the user after such a gap opens an absence, which "While you were away" shows
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

/** What a window remembers between signs: storage may be missing, and between writes it is behind this window. */
export interface PresenceMemory {
  away: AwayPeriod | undefined;
  lastActive: number | undefined;
  /** When this window last wrote its sign to storage. */
  written: number;
}

/**
 * One sign of the user at `now`: the absence it opens, if any, and whether to write the sign to storage (at most every
 * `PRESENCE_WRITE_MS`, and always with an absence, so the other windows measure from it). Storage is read only when this
 * window's own last sign is old enough for an absence, so a pointer move costs nothing most of the time; the newer of
 * the two last signs counts, since the user may have been in another window meanwhile.
 */
export function presenceSign(
  memory: PresenceMemory,
  now: number,
  stored: () => { lastActive: number | undefined; away: AwayPeriod | undefined },
): { memory: PresenceMemory; opened: AwayPeriod | undefined; write: boolean } {
  const recent = memory.lastActive !== undefined && now - memory.lastActive < AWAY_AFTER_MS;
  const fromStorage = recent ? undefined : stored();
  const opened = fromStorage && absenceAt(newer(memory.lastActive, fromStorage.lastActive), now, fromStorage.away ?? memory.away);
  const write = opened !== undefined || now - memory.written >= PRESENCE_WRITE_MS;
  return { memory: { away: opened ?? memory.away, lastActive: now, written: write ? now : memory.written }, opened, write };
}

function newer(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

/**
 * A pointer move the user made: Chromium and WebView2 also send one when the page moves under a pointer that stands
 * still (a list that grows, a scene that animates), which would keep a window that nobody touches from ever being left.
 */
export function pointerMoved(last: { x: number; y: number } | undefined, x: number, y: number): boolean {
  return last === undefined || last.x !== x || last.y !== y;
}

type StorageAccess = () => Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readLastActive(storage: StorageAccess): number | undefined {
  try {
    const value = Number(storage().getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastActive(storage: StorageAccess, at: number): void {
  try {
    storage().setItem(LAST_ACTIVE_KEY, String(at));
  } catch {
    // This window still remembers it; the others measure from their own.
  }
}

/** The absence another window wrote, read with a schema, since anything on this origin may have written the key. */
export function readAway(storage: StorageAccess): AwayPeriod | undefined {
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
export function saveAway(storage: StorageAccess, away: AwayPeriod | undefined): void {
  try {
    if (away === undefined) storage().removeItem(AWAY_KEY);
    else storage().setItem(AWAY_KEY, JSON.stringify(away));
  } catch {
    // Only this window shows or dismisses it then.
  }
}
