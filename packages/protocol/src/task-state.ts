import { z } from "zod";

/**
 * Stan zadania (§4.4, §6): co sesja zadania robi teraz i skąd to wiadomo. UI pokazuje stan razem ze źródłem
 * i pewnością, więc słabszy sygnał może być podany jako „prawdopodobnie”.
 */

export const TaskState = z.enum(["Working", "Input", "Approval", "Plan", "Done", "Error", "Stale"]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * `hook`: hook CLI agenta; `osc`: sekwencja terminala; `screen`: wzorzec ekranu; `timeout`: brak sygnału
 * dłużej niż próg; `exit`: zakończenie procesu sesji zaobserwowane przez daemon.
 */
export const TaskStateSource = z.enum(["hook", "osc", "screen", "timeout", "exit"]);
export type TaskStateSource = z.infer<typeof TaskStateSource>;

/** Pewność (słownik w `CONTEXT.md`); ta sama skala co przy krawędziach grafu. */
export const Confidence = z.enum(["exact", "high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const TaskStateChange = z.object({
  state: TaskState,
  source: TaskStateSource,
  confidence: Confidence,
  /** Czas zmiany, ISO 8601. */
  at: z.string(),
  /** Krótko, z czego wynika stan, np. `hook agentStop` albo `osc 9;4;0`. */
  reason: z.string(),
});
export type TaskStateChange = z.infer<typeof TaskStateChange>;
