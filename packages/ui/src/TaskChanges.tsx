import { agentsApi, type ChangedFile, type WorktreeChanges } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Badge } from "@/components/ui/badge";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type DiffLineKind, diffLines } from "@/lib/diff-lines";
import { countLabel } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/** Diff na żywo: tyle, ile trwa jeden `git status` w worktree, i rzadziej nie ma sensu, gdy agent pisze pliki. */
const POLL_MS = 2000;
/** Ponad tyle linii przeglądarka zaczyna się dławić, a resztę i tak lepiej czytać w VS Code. */
const MAX_LINES = 4000;

const CHANGE_LABELS = {
  added: { label: "nowy", variant: "success" },
  modified: { label: "zmieniony", variant: "default" },
  deleted: { label: "usunięty", variant: "destructive" },
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
 * Zakładka „Zmiany” zadania (ADR-31): pliki i diff worktree względem commita bazowego, odpytywane co 2 s, póki
 * zakładka jest otwarta, więc widać, co agent robi, zanim cokolwiek zacommituje.
 */
export function TaskChanges({ conn, task }: { conn: Connection; task: string }) {
  const load = useCallback(() => post(conn, agentsApi.taskChanges, { task }), [conn, task]);
  const changes = useRemote(load, { pollMs: POLL_MS });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  return <ChangesBody changes={changes.data} />;
}

function ChangesBody({ changes }: { changes: WorktreeChanges }) {
  const { files, commits, uncommitted } = changes;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">Agent jeszcze niczego nie zmienił.</p>;
  const { lines, more } = diffLines(changes.patch, MAX_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "plik", few: "pliki", many: "plików" })} ·{" "}
        {countLabel(commits, { one: "commit", few: "commity", many: "commitów" })} zadania · niezacommitowane: {uncommitted}
      </p>
      <ul className="flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 text-sm">
            <Badge variant={CHANGE_LABELS[file.change].variant}>{CHANGE_LABELS[file.change].label}</Badge>
            <span className="truncate font-mono text-xs">{file.path}</span>
            <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
              {file.additions === null ? "binarny" : `+${file.additions} −${file.deletions}`}
            </span>
          </li>
        ))}
      </ul>
      <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-5">
        {lines.map((line) => (
          <div key={line.offset} className={cn("px-1 whitespace-pre", LINE_CLASSES[line.kind])}>
            {line.text || " "}
          </div>
        ))}
      </pre>
      {(changes.truncated || more) && (
        <p className="text-muted-foreground text-xs">Diff jest dłuższy; pokazano początek. Całość zobaczysz w VS Code.</p>
      )}
    </div>
  );
}
