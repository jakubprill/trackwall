import { agentsApi, countLabel, type MiseConfigChange } from "@trackwall/protocol";
import { ShieldAlert } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** The agent edits the config within seconds of the user's look; a few seconds late is fine for a warning that blocks nothing in the UI. */
const POLL_MS = 5000;

const CHANGE_LABEL: Record<MiseConfigChange["change"], string> = { added: "added", modified: "changed", removed: "deleted" };

/**
 * The warning above a task's tabs when the agent changed the mise config of its worktree (ADR-59): Trackwall runs no
 * mise task there until the user trusts the config they see here. Trusting sends the digest of this exact config, so a
 * newer change is refused and shows up instead. A failed check shows nothing, like the shared files warning.
 */
export function TaskMiseConfig({ conn, task, paused }: { conn: Connection; task: string; paused: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskMiseConfig, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: POLL_MS });
  const trust = useAction(
    (digest: string) => post(conn, agentsApi.trustTaskMiseConfig, { task, digest }),
    () => remote.reload(),
  );
  const config = remote.error ? undefined : remote.data;
  if (!config || config.changes.length === 0) return null;
  return (
    <section aria-label="Changed mise config" className="border-warning/40 bg-warning/10 flex items-start gap-3 border-b px-4 py-3">
      <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">
          {`The agent changed the mise config of this task (${countLabel(config.changes.length, { one: "file", other: "files" })})`}
        </p>
        <ul className="text-muted-foreground flex flex-col font-mono text-xs">
          {config.changes.map((c) => (
            <li key={c.path} className="truncate">{`${CHANGE_LABEL[c.change]} ${c.path}`}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          mise tasks do not run in this worktree until you trust it. Check the changes first: a mise config can run any command.
        </p>
        {trust.error && <p className="text-destructive text-xs">{trust.error}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={() => trust.run(config.digest)} disabled={trust.pending}>
        Trust this config
      </Button>
    </section>
  );
}
