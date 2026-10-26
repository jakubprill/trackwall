import { localConfigApi, type RepoLocalConfig as RepoLocalConfigData } from "@trackwall/protocol";
import { EyeOff, RotateCcw } from "lucide-react";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { canIgnore, canRestore, hasLocalConfig, localConfigFileStatus } from "@/lib/local-config";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** A file saved in the repo reaches the store within a few seconds; the panel follows at a slower pace. */
const POLL_MS = 10_000;

/**
 * The repo's local config files against the local config store (ADR-86): `mise.local.toml` and `.worktreeinclude`, kept
 * outside git, backed up on their own; Restore after a new clone and Ignore locally for a file git would commit.
 */
export function RepoLocalConfig({ conn, repo, onRestored }: { conn: Connection; repo: string; onRestored: () => void }) {
  const load = useCallback(() => post(conn, localConfigApi.repo, { repo }), [conn, repo]);
  const remote = useRemote(load, { pollMs: POLL_MS });
  if (remote.error) return <ErrorWithRetry message={`Local config: ${remote.error}`} onRetry={remote.reload} />;
  if (!remote.data) return null;
  return (
    <LocalConfigPanel
      conn={conn}
      config={remote.data}
      onChange={(restored) => {
        remote.reload();
        if (restored) onRestored();
      }}
    />
  );
}

function LocalConfigPanel({
  conn,
  config,
  onChange,
}: {
  conn: Connection;
  config: RepoLocalConfigData;
  onChange: (restored: boolean) => void;
}) {
  const restore = useAction(
    () => post(conn, localConfigApi.restore, { repo: config.repo }),
    () => onChange(true),
  );
  const ignore = useAction(
    () => post(conn, localConfigApi.ignore, { repo: config.repo }),
    () => onChange(false),
  );
  if (!hasLocalConfig(config)) {
    return (
      <p className="text-muted-foreground text-xs">
        Tasks only for this computer go in mise.local.toml in the repo root: Trackwall backs it up to the local config store, outside the
        repo.
      </p>
    );
  }
  return (
    <Surface label="Local config" note="Kept outside git and backed up to the local config store in your projects folder.">
      <ul className="divide-y">
        {config.files.map((state) => (
          <li key={state.file} className="flex items-center gap-3 px-3 py-2 text-sm">
            <code className="text-primary flex-1 truncate text-xs">{state.file}</code>
            <span className="text-xs">
              <StatusLabel {...localConfigFileStatus(state)} />
            </span>
          </li>
        ))}
      </ul>
      {(canRestore(config) || canIgnore(config)) && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          {canRestore(config) && (
            <Button variant="outline" size="sm" onClick={restore.run} disabled={restore.pending}>
              <RotateCcw /> Restore from the store
            </Button>
          )}
          {canIgnore(config) && (
            <Button variant="outline" size="sm" onClick={ignore.run} disabled={ignore.pending}>
              <EyeOff /> Ignore locally
            </Button>
          )}
          {(restore.error ?? ignore.error) && <p className="text-destructive text-xs">{restore.error ?? ignore.error}</p>}
        </div>
      )}
    </Surface>
  );
}
