import { agentsApi, type TaskMiseConfig as Config, countLabel, type MiseConfigChange } from "@trackwall/protocol";
import { ShieldAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { changedSinceShown, shownMiseConfig } from "@/lib/mise-config-review";
import { useAction } from "@/lib/use-action";
import type { TaskDetails } from "@/lib/use-task-details";

const CHANGE_LABEL: Record<MiseConfigChange["change"], string> = { added: "added", modified: "changed", removed: "deleted" };

/**
 * The warning above a task's tabs when the agent changed the mise config of its worktree (ADR-59): Trackwall runs no
 * mise task there until the user trusts the config they read here. The panel keeps showing the version it first
 * showed, and a newer one only after the user asks for it, so the trust always names (by its digest) the text on
 * screen, not one that arrived with a poll a moment before the click (`shownMiseConfig`). A config Trackwall cannot
 * check (a link out of the worktree, too many files) shows why; another failed check shows nothing, like the shared
 * files warning. The data comes from `useTaskDetails`.
 */
export function TaskMiseConfig({ conn, task, remote }: { conn: Connection; task: string; remote: TaskDetails["miseConfig"] }) {
  const [shown, setShown] = useState<Config>();
  const [trustedDigest, setTrustedDigest] = useState<string>();
  const trust = useAction(
    (digest: string) => post(conn, agentsApi.trustTaskMiseConfig, { task, digest }),
    (result) => {
      setTrustedDigest(result.digest);
      remote.reload();
    },
  );
  const latest = remote.error ? undefined : remote.data;
  // Adjusting state during render, as React documents for state derived from props: no extra render with stale text.
  const next = shownMiseConfig(shown, latest, trustedDigest);
  if (next !== shown) setShown(next);
  // The trust is shown as done only until the daemon reports the trusted config, so a later return to that version warns.
  if (trustedDigest !== undefined && latest?.changes.length === 0) setTrustedDigest(undefined);
  if (remote.error)
    return remote.errorCode === "mise_unavailable" ? (
      <Warning title="mise tasks cannot run in this worktree">
        <p className="text-muted-foreground text-xs">{remote.error}</p>
      </Warning>
    ) : null;
  if (!next) return null;
  const changedAgain = changedSinceShown(next, latest);
  return (
    <Warning
      title={heading(next)}
      action={
        <Button variant="outline" size="sm" onClick={() => trust.run(next.digest)} disabled={trust.pending || changedAgain}>
          Trust this config
        </Button>
      }
    >
      {next.changes.map((c) => (
        <ChangedFile key={c.path} change={c} />
      ))}
      <p className="text-muted-foreground text-xs">
        mise tasks do not run in this worktree until you trust it. Read the files first: a mise config can run any command.
      </p>
      {changedAgain && latest && (
        <div className="flex items-center gap-2">
          <p className="text-warning text-xs">The agent changed the mise config again since this was shown.</p>
          <Button variant="ghost" size="sm" onClick={() => setShown(latest)}>
            Show the new version
          </Button>
        </div>
      )}
      {trust.error && <p className="text-destructive text-xs">{trust.error}</p>}
    </Warning>
  );
}

function Warning({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section
      aria-label="mise config of this worktree"
      className="border-warning/40 bg-warning/10 flex items-start gap-3 border-b px-4 py-3"
    >
      <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
      {action}
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
