import { countLabel } from "@trackwall/protocol";

/**
 * The words of the shared-files warning (ADR-44) and of its trial merge (ADR-230). `conflicts` is `null` when git could
 * not try the merge (older than 2.38, a branch gone), which says nothing about a conflict.
 */

/** How the files shared with one other task read: how many, and how many of them conflict. */
export interface SharedWithCounts {
  files: number;
  conflicts: number | null;
}

/** The line about the files shared with the task `name` (its name with “quotes”). */
export function sharedFilesHeadline({ files, conflicts }: SharedWithCounts, name: string): string {
  if (!conflicts) return `${countLabel(files, { one: "file is", other: "files are" })} also changed by ${name}`;
  const clean = files - conflicts;
  const rest = clean > 0 ? `; ${countLabel(clean, { one: "other shared file merges", other: "other shared files merge" })} cleanly` : "";
  return `${countLabel(conflicts, { one: "conflicting file", other: "conflicting files" })} with ${name}${rest}`;
}

/** The note under the lines of all other tasks. */
export function sharedFilesFootnote(shared: readonly SharedWithCounts[]): string {
  if (shared.some(({ conflicts }) => (conflicts ?? 0) > 0))
    return "Merging what both tasks committed so far conflicts in the conflicting files. The task merged second will have to resolve them.";
  if (shared.some(({ conflicts }) => conflicts === null)) return "Both tasks change these files. The one merged second may get a conflict.";
  return "What both tasks committed so far merges cleanly. Work they have not committed yet may still conflict.";
}
