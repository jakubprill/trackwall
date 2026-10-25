import { agentsApi, type TaskMiseConfig as Config, countLabel, type MiseConfigChange } from "@trackwall/protocol";
import { ShieldAlert } from "lucide-react";
import { useCallback, useState } from "react";
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
 * mise task there until the user trusts the config they read here. The panel keeps showing the version it first
 * showed, and a newer one only after the user asks for it, so the trust always names (by its digest) the text on
 * screen, not one that arrived with a poll a moment before the click. A failed check shows nothing, like the shared
 * files warning.
 */
export function TaskMiseConfig({ conn, task, paused }: { conn: Connection; task: string; paused: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskMiseConfig, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: POLL_MS });
  const [shown, setShown] = useState<Config>();
  const trust = useAction(
    (digest: string) => post(conn, agentsApi.trustTaskMiseConfig, { task, digest }),
    () => {
      setShown(undefined);
      remote.reload();
    },
  );
  const latest = remote.error ? undefined : remote.data;
  // Pinning during render (React's "adjusting state when a prop changes"): the first version with changes stays on
  // screen, and a config without changes (trusted, or reverted by the agent) ends the warning.
  if (latest?.changes.length === 0 && shown) setShown(undefined);
  if (latest && latest.changes.length > 0 && !shown) setShown(latest);
  const config = shown ?? latest;
  if (!config || config.changes.length === 0 || latest?.changes.length === 0) return null;
  const changedAgain = latest !== undefined && latest.digest !== config.digest;
  return (
    <section aria-label="Changed mise config" className="border-warning/40 bg-warning/10 flex items-start gap-3 border-b px-4 py-3">
      <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">{heading(config)}</p>
        {config.changes.map((c) => (
          <ChangedFile key={c.path} change={c} />
        ))}
        <p className="text-muted-foreground text-xs">
          mise tasks do not run in this worktree until you trust it. Read the files first: a mise config can run any command.
        </p>
        {changedAgain && (
          <div className="flex items-center gap-2">
            <p className="text-warning text-xs">The agent changed the mise config again since this was shown.</p>
            <Button variant="ghost" size="sm" onClick={() => setShown(latest)}>
              Show the new version
            </Button>
          </div>
        )}
        {trust.error && <p className="text-destructive text-xs">{trust.error}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={() => trust.run(config.digest)} disabled={trust.pending || changedAgain}>
        Trust this config
      </Button>
    </section>
  );
}

function heading(config: Config): string {
  const files = countLabel(config.changes.length, { one: "file", other: "files" });
  return config.neverTrusted
    ? `This task's mise config has not been trusted yet (${files})`
    : `The agent changed the mise config of this task (${files})`;
}

function ChangedFile({ change }: { change: MiseConfigChange }) {
  const label = `${CHANGE_LABEL[change.change]} ${change.path}`;
  if (change.change === "removed") return <p className="text-muted-foreground truncate font-mono text-xs">{label}</p>;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground cursor-pointer truncate font-mono">{label}</summary>
      {change.content === null ? (
        <p className="text-muted-foreground mt-1">Too long to show here; open the worktree in VS Code to read it.</p>
      ) : (
        <pre className="bg-background mt-1 max-h-64 overflow-auto rounded border p-2 font-mono whitespace-pre-wrap">{change.content}</pre>
      )}
    </details>
  );
}
