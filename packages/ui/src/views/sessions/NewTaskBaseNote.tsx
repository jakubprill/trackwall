import { type ServerCheckState, type SyncResult, workspaceApi } from "@trackwall/protocol";
import { ArrowDown, RotateCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type NewTaskBaseTone, newTaskBaseLine, syncedTaskBaseLine } from "@/lib/new-task-base";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<NewTaskBaseTone, string> = {
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-border text-muted-foreground",
  ok: "border-success/40 bg-success/10 text-success",
};

/**
 * The line above "Create task" when the repo's default branch, where a new task starts, is behind the server (ADR-297),
 * with "Sync main": the sync of that one repo, as "Sync all" does it. After the sync it says what the sync did, until the
 * form shows another repo, which mounts the line anew. A repo the daemon cannot compare, or one it fails to read, gets no
 * line: it is a hint, and the start never waits for it. `label` names the repo where the form starts a change in several.
 */
export function NewTaskBaseNote({
  conn,
  repo,
  serverCheck,
  label,
}: {
  conn: Connection;
  repo: string;
  serverCheck: ServerCheckState | undefined;
  label: string | null;
}) {
  const load = useCallback(() => post(conn, workspaceApi.newTaskBase, { repo }), [conn, repo]);
  const base = useRemote(load);
  const [synced, setSynced] = useState<SyncResult | null>(null);
  const sync = useAction(() => post(conn, workspaceApi.syncRepo, { repo }), setSynced);
  const line = synced !== null ? syncedTaskBaseLine(synced) : newTaskBaseLine(repo, base.data ?? null, serverCheck, new Date());
  if (line === null) return null;
  return (
    <div
      role="status"
      className={cn("flex max-w-prose flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-2.5 py-2 text-xs", TONE_CLASS[line.tone])}
    >
      <p className="min-w-0 flex-[1_1_16rem] break-words">
        {label !== null && <span className="text-foreground mr-1.5 font-mono">{label}</span>}
        {line.text}
      </p>
      {line.sync !== null && (
        <Button variant="outline" size="sm" className="h-7" disabled={sync.pending} onClick={() => sync.run()}>
          {sync.pending ? <RotateCw className="animate-spin" /> : <ArrowDown />}
          {sync.pending ? "Syncing…" : line.sync}
        </Button>
      )}
      {sync.error && <p className="text-destructive w-full whitespace-pre-wrap break-words">Sync failed: {sync.error}</p>}
    </div>
  );
}
