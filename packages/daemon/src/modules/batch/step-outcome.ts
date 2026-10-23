import type { BatchStepState, RunState, SyncResult } from "@trackwall/protocol";

/** Wynik kroku komendy zbiorczej (§4.8) z wyniku synchronizacji albo z końca uruchomienia `mise`. */

/** Pominięta synchronizacja nie zatrzymuje repo: kolejne kroki działają na tym, co jest lokalnie. */
export function syncOutcome(result: SyncResult): BatchStepState {
  switch (result.state) {
    case "updated":
      return { state: "done", detail: `${result.branch} +${result.commits}` };
    case "up-to-date":
      return { state: "done", detail: `${result.branch} aktualna` };
    case "skipped":
      return { state: "skipped", message: result.message };
  }
}

/** Stop z UI, przerwanie komendy i wyjście daemona dają `stoppedByUser`, więc to przerwanie, a nie błąd. */
export function runOutcome(run: RunState): BatchStepState {
  if (run.kind !== "exited") throw new Error(`uruchomienie ${run.runId} jeszcze trwa (${run.kind})`);
  if (run.stoppedByUser) return { state: "cancelled" };
  if (run.exitCode === 0) return { state: "done", detail: null };
  const message = run.exitCode === null ? `zakończony sygnałem ${run.signal}` : `zakończony kodem ${run.exitCode}`;
  return { state: "failed", message, lastLines: run.lastLines };
}
