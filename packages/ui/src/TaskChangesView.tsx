import { agentsApi, type ChangedFile, type TaskChanges } from "@trackwall/protocol";
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

/**
 * Diff na żywo: agent zmienia pliki w ciągu sekund, a jedno pytanie to kilka szybkich poleceń gita na worktree
 * (koszt w ADR-31); następne idzie dopiero po odpowiedzi, więc wolny git nie piętrzy pytań.
 */
const POLL_MS = 2000;
/** Ponad tyle linii przeglądarka zaczyna się dławić, a resztę i tak lepiej czytać w VS Code. */
const MAX_LINES = 4000;

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
 * Zakładka „Zmiany” zadania (ADR-31): pliki i diff worktree względem commita bazowego, odpytywane co 2 s, póki
 * zakładka jest otwarta, więc widać, co agent robi, zanim cokolwiek zacommituje. `paused` wstrzymuje odpytywanie
 * (w trakcie zakończenia zadania worktree znika), zostawiając ostatnie dane.
 */
export function TaskChangesView({ conn, task, paused }: { conn: Connection; task: string; paused: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskChanges, { task }), [conn, task]);
  const changes = useRemote(paused ? undefined : load, { pollMs: POLL_MS });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  return <ChangesBody changes={changes.data} />;
}

function ChangesBody({ changes }: { changes: TaskChanges }) {
  const { files, commits, uncommitted } = changes;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The agent has not changed anything yet.</p>;
  const { lines, more } = diffLines(changes.patch, MAX_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} · {countLabel(commits, { one: "task commit", other: "task commits" })} ·
        uncommitted: {uncommitted}
      </p>
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
      <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-5">
        {lines.map((line) => (
          <div key={line.offset} className={cn("px-1 whitespace-pre", LINE_CLASSES[line.kind])}>
            {line.text || " "}
          </div>
        ))}
      </pre>
      {(changes.truncated || more) && (
        <p className="text-muted-foreground text-xs">The diff is longer; showing the beginning. See all of it in VS Code.</p>
      )}
    </div>
  );
}
