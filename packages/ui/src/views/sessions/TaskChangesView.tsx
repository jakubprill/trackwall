import { agentsApi, countLabel, type TaskChanges } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * Diff na żywo: agent zmienia pliki w ciągu sekund, a jedno pytanie to kilka szybkich poleceń gita na worktree
 * (koszt w ADR-31); następne idzie dopiero po odpowiedzi, więc wolny git nie piętrzy pytań.
 */
const POLL_MS = 2000;

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
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} · {countLabel(commits, { one: "task commit", other: "task commits" })} ·
        uncommitted: {uncommitted}
      </p>
      <ChangesDiff changes={changes} />
    </div>
  );
}
