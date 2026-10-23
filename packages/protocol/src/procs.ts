import { z } from "zod";

/**
 * Kontrakt modułu `procs` (§4.1) widoczny dla klientów: stan jednego uruchomienia, czyli grupy procesów
 * z jednym liderem. Stan jest zaobserwowany: `exited` dopiero wtedy, gdy daemon sprawdził, że żaden proces grupy
 * nie żyje.
 */

/** Ostatnie linie wyjścia (stdout i stderr w kolejności przyjścia) pokazywane przy zakończonym uruchomieniu. */
export const RUN_TAIL_LINES = 20;

const RunBase = z.object({
  runId: z.string(),
  /** ISO 8601. */
  startedAt: z.string(),
});

export const RunState = z.discriminatedUnion("kind", [
  RunBase.extend({ kind: z.literal("running"), pid: z.number().int().positive() }),
  /** Daemon zatrzymuje grupę: łagodny stop, po czasie łaski zabicie całej grupy. */
  RunBase.extend({ kind: z.literal("stopping"), pid: z.number().int().positive() }),
  RunBase.extend({
    kind: z.literal("exited"),
    endedAt: z.string(),
    /** Kod wyjścia lidera; `null`, gdy zakończył go sygnał. */
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    /** Zakończone przez użytkownika (stop z UI albo wyjście daemona), a nie samo. */
    stoppedByUser: z.boolean(),
    lastLines: z.array(z.string()).max(RUN_TAIL_LINES),
  }),
]);
export type RunState = z.infer<typeof RunState>;
