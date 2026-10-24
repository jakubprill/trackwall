import { z } from "zod";

/**
 * Zmiany katalogu roboczego względem commita: worktree zadania względem commita bazowego (ADR-31) i katalog roboczy
 * repo z folderu z projektami względem HEAD (zakładka „Changes”, ADR-34). Ten sam odczyt gita w obu miejscach.
 */

/** Plik zmieniony względem commita; `null` w liczbie linii dla pliku binarnego. Nowy plik, także nieśledzony, to `added`. */
export const ChangedFile = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** Limit diffu w `WorkingTreeChanges.patch`: więcej i tak nikt nie przewija, a resztę lepiej czytać w VS Code. */
export const PATCH_MAX_BYTES = 1024 * 1024;

/** Katalog roboczy (z nowymi plikami, bez ignorowanych) względem commita. */
export const WorkingTreeChanges = z.object({
  files: z.array(ChangedFile),
  /** Zunifikowany diff, ucięty do `PATCH_MAX_BYTES`. */
  patch: z.string(),
  /** Diff albo lista plików są ucięte. */
  truncated: z.boolean(),
});
export type WorkingTreeChanges = z.infer<typeof WorkingTreeChanges>;
