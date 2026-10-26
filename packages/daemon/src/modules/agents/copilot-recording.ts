import { TaskStateChange } from "@trackwall/protocol";
import { z } from "zod";
import { type Asciicast, eventTimeMs } from "./asciicast.ts";
import { CopilotHookRecord } from "./copilot-hook-record.ts";
import { SessionKey } from "./copilot-keys.ts";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { jsonOf } from "./json.ts";

/**
 * A Copilot CLI session recording (§4.4, §10): markers (`m`) with hook records, the kind of session key and the exit
 * code, the lines of `states.jsonl`, and replaying state detection from a recording. The recording alone is enough to
 * compute the state again after the rules change. A hook marker has the time `hooks.jsonl` was read (up to ~200 ms after
 * the hook), so in a replay the hook lands among the output in the same order as live.
 */

const SessionMarker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hook"), record: CopilotHookRecord }),
  z.object({ kind: z.literal("key"), key: SessionKey }),
  z.object({ kind: z.literal("exit"), code: z.number().int() }),
]);
type SessionMarker = z.infer<typeof SessionMarker>;
const SessionMarkerLabel = jsonOf(SessionMarker);

export function encodeMarker(marker: SessionMarker): string {
  return JSON.stringify(marker);
}

/** `undefined` for a marker added by hand in the player (plain text or other JSON): not a recording error. */
function decodeMarker(label: string): SessionMarker | undefined {
  return SessionMarkerLabel.safeParse(label).data;
}

/** A line of `states.jsonl`: a state change and the window title at the moment of the change. */
export const StatesLine = TaskStateChange.extend({ windowTitle: z.string().optional() });
export type StatesLine = z.infer<typeof StatesLine>;

export interface ReplayOptions {
  staleAfterMs: number;
}

/** State changes in the order they appeared live; time counted from the recording's header. */
export function replayCopilotRecording(cast: Asciicast, o: ReplayOptions): TaskStateChange[] {
  let now = eventTimeMs(cast.header, 0);
  const session = new CopilotSessionState({ now: () => now, staleAfterMs: o.staleAfterMs, promptOnStart: false, program: null });
  const changes: (TaskStateChange | undefined)[] = [];
  for (const [seconds, code, data] of cast.events) {
    now = eventTimeMs(cast.header, seconds);
    changes.push(session.tick());
    if (code === "o") changes.push(...session.output(data));
    if (code !== "m") continue;
    const marker = decodeMarker(data);
    // A recording keeps no screen image, so no approval dialog is seen on it.
    if (marker?.kind === "hook") changes.push(...session.hook(marker.record, () => false));
    if (marker?.kind === "key") changes.push(...session.key(marker.key));
    if (marker?.kind === "exit") changes.push(...session.exit(marker.code));
  }
  return changes.filter((c) => c !== undefined);
}
