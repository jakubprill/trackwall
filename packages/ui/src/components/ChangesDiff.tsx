import type { ChangedFile, WorkingTreeChanges } from "@trackwall/protocol";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { type DiffLine, type DiffLineKind, diffLines } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/** Beyond this many lines or files the browser starts to choke, and the rest is better read in VS Code anyway. */
const MAX_LINES = 4000;
const MAX_FILES = 500;

const CHANGE_LABELS = {
  added: { label: "added", variant: "success" },
  modified: { label: "modified", variant: "default" },
  deleted: { label: "deleted", variant: "destructive" },
} as const satisfies Record<ChangedFile["change"], { label: string; variant: string }>;

const LINE_CLASSES: Record<DiffLineKind, string> = {
  file: "text-foreground mt-3 font-medium first:mt-0",
  meta: "text-muted-foreground",
  hunk: "text-primary",
  added: "text-success bg-success/10",
  removed: "text-destructive bg-destructive/10",
  context: "text-muted-foreground",
};

/**
 * What a view adds to the diff lines: a task's review comments (ADR-62) put a button in front of every line of a change
 * and the comment form under it. Both get only lines with an anchor.
 */
export interface LineAnnotations {
  gutter: (line: DiffLine) => ReactNode;
  below: (line: DiffLine) => ReactNode;
}

/**
 * Files and diff of the working directory against a commit: a task's changes (ADR-31) and a repo's "Changes" tab (ADR-34).
 * An empty set of files stays with the caller, because each view says something different about it.
 */
export function ChangesDiff({ changes, annotations }: { changes: WorkingTreeChanges; annotations?: LineAnnotations }) {
  const { lines, more } = diffLines(changes.patch, MAX_LINES);
  const files = changes.files.slice(0, MAX_FILES);
  return (
    <>
      <ul className="flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 text-sm">
            <Badge variant={CHANGE_LABELS[file.change].variant}>{CHANGE_LABELS[file.change].label}</Badge>
            <span className="truncate font-mono text-xs">{file.path}</span>
            <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
              {file.additions === null ? "binary" : `+${file.additions} −${file.deletions}`}
            </span>
          </li>
        ))}
      </ul>
      {files.length < changes.files.length && (
        <p className="text-muted-foreground text-xs">
          Showing the first {MAX_FILES} of {changes.files.length} files.
        </p>
      )}
      <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-5">
        {lines.map((line) =>
          annotations ? (
            <Fragment key={line.offset}>
              <div className={cn("group flex px-1 whitespace-pre", LINE_CLASSES[line.kind])}>
                <span className="w-5 shrink-0">{line.anchor && annotations.gutter(line)}</span>
                {line.text || " "}
              </div>
              {line.anchor && annotations.below(line)}
            </Fragment>
          ) : (
            <div key={line.offset} className={cn("px-1 whitespace-pre", LINE_CLASSES[line.kind])}>
              {line.text || " "}
            </div>
          ),
        )}
      </pre>
      {(changes.truncated || more) && (
        <p className="text-muted-foreground text-xs">The changes are longer; showing the beginning. See all of them in VS Code.</p>
      )}
    </>
  );
}
