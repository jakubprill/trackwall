import { setTimeout as sleep } from "node:timers/promises";
import type { Session, Task, TaskProposal, WaitStatus } from "@trackwall/protocol";

/**
 * Czekanie na sesję albo zadanie (`wait_for_session`, ADR-39): co cykl sesji odczyt stanu z pamięci daemona, aż stan
 * wymaga kogoś (sesja czeka na człowieka, nie odpowiada, skończyła się, propozycję odrzucono) albo minie limit czasu.
 * Odpytywanie zamiast źródła zdarzeń `/ws`, bo czeka się na jeden obiekt, a odczyt sesji to odczyt z pamięci.
 */

/** Tyle co cykl sesji (`TICK_MS` w `agents.ts`), z którego przychodzą nowe rekordy hooków. */
const CHECK_MS = 200;

/** Stany, w których czekanie trwa dalej. */
const UNSETTLED: ReadonlySet<WaitStatus> = new Set(["proposal_pending", "starting", "working"]);

/** Co zastało czekanie: stan i obiekty, których dotyczy. */
export interface WaitOutcome {
  status: WaitStatus;
  proposal: TaskProposal | null;
  task: Task | null;
  session: Session | null;
  /** The user's reason for `proposal_rejected` (ADR-55); `null` otherwise and when they gave none. */
  rejectionReason: string | null;
}

/**
 * Stan sesji dla czekającego; zatrzymywana sesja wciąż pracuje, dopóki jej grupa nie skończy. Błąd (`Error` z hooka
 * `errorOccurred`) też wymaga kogoś: nie wiadomo, czy Copilot CLI wyśle po nim koniec tury, a bez tego czekanie
 * wracałoby z `working` po każdym limicie czasu.
 */
export function sessionWaitStatus(session: Session): WaitStatus {
  if (session.run.kind === "exited") return "exited";
  if (session.needsAttention || session.state?.state === "Error") return "needs_attention";
  return session.state?.state === "Stale" ? "stale" : "working";
}

/** `read` co cykl, aż stan przestanie być „w toku”, minie `timeoutMs` albo klient przerwie wywołanie. */
export async function waitUntilSettled(read: () => WaitOutcome, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const outcome = read();
    const left = until - Date.now();
    if (!UNSETTLED.has(outcome.status) || left <= 0 || signal.aborted) return outcome;
    try {
      await sleep(Math.min(CHECK_MS, left), undefined, { signal });
    } catch {
      return read();
    }
  }
}
