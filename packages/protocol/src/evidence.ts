import { z } from "zod";

/** Plik i linia w drzewie commita, z których wynika fakt; `line` `null`, gdy fakt dotyczy całego pliku. */
export const Evidence = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Dowód jako `ścieżka:linia`, a bez linii sama ścieżka; jeden zapis w powodach tagów i w UI. */
export function evidenceLabel(evidence: Evidence): string {
  return evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`;
}
