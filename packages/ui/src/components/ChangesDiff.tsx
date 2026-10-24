import type { ChangedFile, WorkingTreeChanges } from "@trackwall/protocol";
import { Badge } from "@/components/ui/badge";
import { type DiffLineKind, diffLines } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/** Ponad tyle linii albo plików przeglądarka zaczyna się dławić, a resztę i tak lepiej czytać w VS Code. */
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
 * Pliki i diff katalogu roboczego względem commita: zmiany zadania (ADR-31) i zakładka „Changes” repo (ADR-34).
 * Pusty zestaw plików zostaje u wywołującego, bo każdy widok mówi o nim co innego.
 */
export function ChangesDiff({ changes }: { changes: WorkingTreeChanges }) {
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
        {lines.map((line) => (
          <div key={line.offset} className={cn("px-1 whitespace-pre", LINE_CLASSES[line.kind])}>
            {line.text || " "}
          </div>
        ))}
      </pre>
      {(changes.truncated || more) && (
        <p className="text-muted-foreground text-xs">The changes are longer; showing the beginning. See all of them in VS Code.</p>
      )}
    </>
  );
}
