import { TaskStateChange } from "@trackwall/protocol";
import { z } from "zod";
import { type Asciicast, eventTimeMs } from "./asciicast.ts";
import { CopilotHookRecord } from "./copilot-hook-record.ts";
import { SessionKey } from "./copilot-keys.ts";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { jsonOf } from "./json.ts";

/**
 * Nagranie sesji Copilot CLI (§4.4, §10): znaczniki (`m`) z rekordami hooków, rodzajem klawisza i kodem wyjścia, linie
 * `states.jsonl` i odtwarzanie wykrywania stanu z nagrania. Samo nagranie wystarcza, żeby policzyć stan jeszcze raz
 * po zmianie reguł. Znacznik hooka ma czas odczytu `hooks.jsonl` (do ~200 ms po hooku), więc przy odtwarzaniu
 * hook trafia między wyjście w tej samej kolejności co na żywo.
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

/** `undefined` dla znacznika dodanego ręcznie w odtwarzaczu (zwykły tekst albo inny JSON): to nie błąd nagrania. */
function decodeMarker(label: string): SessionMarker | undefined {
  return SessionMarkerLabel.safeParse(label).data;
}

/** Linia `states.jsonl`: zmiana stanu i tytuł okna w chwili zmiany. */
export const StatesLine = TaskStateChange.extend({ windowTitle: z.string().optional() });
export type StatesLine = z.infer<typeof StatesLine>;

export interface ReplayOptions {
  staleAfterMs: number;
}

/** Zmiany stanu w kolejności, w jakiej pojawiły się na żywo; czas liczony od nagłówka nagrania. */
export function replayCopilotRecording(cast: Asciicast, o: ReplayOptions): TaskStateChange[] {
  let now = eventTimeMs(cast.header, 0);
  const session = new CopilotSessionState({ now: () => now, staleAfterMs: o.staleAfterMs });
  const changes: (TaskStateChange | undefined)[] = [];
  for (const [seconds, code, data] of cast.events) {
    now = eventTimeMs(cast.header, seconds);
    changes.push(session.tick());
    if (code === "o") changes.push(...session.output(data));
    if (code !== "m") continue;
    const marker = decodeMarker(data);
    if (marker?.kind === "hook") changes.push(...session.hook(marker.record));
    if (marker?.kind === "key") changes.push(...session.key(marker.key));
    if (marker?.kind === "exit") changes.push(...session.exit(marker.code));
  }
  return changes.filter((c) => c !== undefined);
}
