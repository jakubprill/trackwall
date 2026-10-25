import { z } from "zod";

/** The file and line in the commit's tree a fact comes from; `line` is `null` when the fact concerns the whole file. */
export const Evidence = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Evidence as `path:line`, and without a line just the path; one notation in tag reasons and in the UI. */
export function evidenceLabel(evidence: Evidence): string {
  return evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`;
}
