import { countLabel, type Task, WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { FileInput, TriangleAlert } from "lucide-react";

/** This many paths fit on one line; the rest is a count, and all of them are in the tooltip. */
const SHOWN_FILES = 3;

/**
 * The files the task's worktree got from the repo root when it was created (ADR-61): ignored files such as `.env`
 * that the root's `.worktreeinclude` names, so the user knows which local config the agent works with, and what was
 * not copied. Hidden when the root names none.
 */
export function TaskIncludedFiles({ included }: { included: Task["included"] }) {
  const { files, problems } = included;
  if (files.length === 0 && problems.length === 0) return null;
  const rest = files.length - SHOWN_FILES;
  return (
    <section aria-label="Included files" className="flex flex-col gap-1 border-b px-4 py-2 text-xs">
      {files.length > 0 && (
        <p className="flex min-w-0 items-center gap-2">
          <FileInput className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0">{`Included files (${WORKTREE_INCLUDE_FILE}), ${countLabel(files.length, { one: "file", other: "files" })} from the repo:`}</span>
          <span className="text-muted-foreground truncate font-mono" title={files.join("\n")}>
            {files.slice(0, SHOWN_FILES).join(" · ")}
            {rest > 0 && ` · ${rest} more`}
          </span>
        </p>
      )}
      {problems.map((problem) => (
        <p key={problem} className="flex min-w-0 items-start gap-2">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="text-muted-foreground">{`Not copied: ${problem}`}</span>
        </p>
      ))}
    </section>
  );
}
