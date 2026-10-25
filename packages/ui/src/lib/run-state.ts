import type { RunState } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/** Running mise tasks come live from the events WebSocket; polled only while it is not connected (Home, task panel). */
export const RUNNING_MISE_POLL_MS = 3000;

/**
 * Stan uruchomienia (`RunState`, §4.1) w jednej linii; dziś pokazują go taski mise, później serwisy. Ton ma tylko to, co wymaga uwagi albo działa;
 * task nieuruchamiany i zatrzymany przez użytkownika są bez tonu (zwykły tekst).
 */
export function runStateLabel(run: RunState | null): { tone?: StatusTone; label: string } {
  if (!run) return { label: "not started" };
  if (run.kind === "running") return { tone: "ok", label: "running" };
  if (run.kind === "stopping") return { tone: "warning", label: "stopping" };
  if (run.stoppedByUser) return { label: "stopped" };
  if (run.exitCode === 0) return { label: "finished" };
  return { tone: "error", label: run.exitCode === null ? `killed (${run.signal ?? "signal"})` : `failed, code ${run.exitCode}` };
}

/** Ostatnie linie wyjścia pokazujemy tylko wtedy, gdy task zakończył się sam i nie kodem 0. */
export function showsLastLines(run: RunState | null): run is Extract<RunState, { kind: "exited" }> {
  return run?.kind === "exited" && !run.stoppedByUser && run.exitCode !== 0 && run.lastLines.length > 0;
}

/** Działający task ma przycisk „Zatrzymaj”, każdy inny „Uruchom”. */
export function isLive(run: RunState | null): boolean {
  return run?.kind === "running" || run?.kind === "stopping";
}
