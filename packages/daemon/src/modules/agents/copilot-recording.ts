import type { TaskStateChange } from "@trackwall/protocol";
import { z } from "zod";
import type { Asciicast } from "./asciicast.ts";
import { CopilotHookRecord } from "./copilot-hooks.ts";
import { CopilotSessionState } from "./copilot-session-state.ts";

/**
 * Znaczniki (`m`) w nagraniu sesji Copilot CLI i odtwarzanie wykrywania stanu z nagrania (§10: detektory
 * testowane na nagraniach). Znacznik niesie rekord hooka albo kod wyjścia procesu, więc samo nagranie
 * wystarcza, żeby policzyć stan jeszcze raz po zmianie reguł.
 */

export const SessionMarker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hook"), record: CopilotHookRecord }),
  z.object({ kind: z.literal("exit"), code: z.number().int() }),
]);
export type SessionMarker = z.infer<typeof SessionMarker>;

export function markerLabel(marker: SessionMarker): string {
  return JSON.stringify(marker);
}

export interface ReplayOptions {
  staleAfterMs: number;
}

/** Zmiany stanu w kolejności, w jakiej pojawiłyby się na żywo; czas liczony od nagłówka nagrania. */
export function replayCopilotRecording(cast: Asciicast, o: ReplayOptions): TaskStateChange[] {
  const startedAt = (cast.header.timestamp ?? 0) * 1000;
  let now = startedAt;
  const session = new CopilotSessionState({ now: () => now, staleAfterMs: o.staleAfterMs });
  const changes: (TaskStateChange | undefined)[] = [];
  for (const [seconds, code, data] of cast.events) {
    now = startedAt + seconds * 1000;
    changes.push(session.tick());
    if (code === "o") changes.push(...session.output(data));
    if (code === "m") changes.push(applyMarker(session, data));
  }
  return changes.filter((c) => c !== undefined);
}

function applyMarker(session: CopilotSessionState, label: string): TaskStateChange | undefined {
  let json: unknown;
  try {
    json = JSON.parse(label);
  } catch {
    return undefined;
  }
  // Znacznik dodany ręcznie w odtwarzaczu (zwykły tekst albo inny JSON) nie jest błędem nagrania.
  const marker = SessionMarker.safeParse(json);
  if (!marker.success) return undefined;
  return marker.data.kind === "hook" ? session.hook(marker.data.record) : session.exit(marker.data.code);
}
