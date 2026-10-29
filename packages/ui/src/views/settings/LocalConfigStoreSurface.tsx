import { localConfigApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { canAllowRemote, localConfigStoreLines } from "@/lib/local-config";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

const POLL_MS = 10_000;

/**
 * The local config store (ADR-86): where the repos' local config files are backed up, the last backup and the push to
 * the store's remote. The store follows the projects folder, and the user adds a remote with git, then allows it here
 * (ADR-127), since an agent can add one too.
 */
export function LocalConfigStoreSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, localConfigApi.store, {}), [conn]);
  const store = useRemote(load, { pollMs: POLL_MS });
  const allow = useAction((remote: string) => post(conn, localConfigApi.allowRemote, { remote }), store.reload);
  return (
    <Surface label="Local config store">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Trackwall backs up each repo's mise.local.toml, .worktreeinclude and a mise.toml the repo does not commit, files you keep out of
          git, into a git repo in your projects folder, and restores them into a new clone. To keep a copy off this computer, add a private
          repo on your repo host as its remote with git (git remote add origin &lt;HTTPS or SSH address&gt;) and allow it here: Trackwall
          pushes every backup to it, and to no other address.
        </p>
        {store.error && <ErrorWithRetry message={store.error} onRetry={store.reload} />}
        {!store.data && !store.error && <Loading />}
        {store.data?.dir === null && <p className="text-sm">Set the projects folder first.</p>}
        {store.data?.dir && (
          <StoreDetails dir={store.data.dir} {...localConfigStoreLines(store.data, new Date())} problem={store.data.problem} />
        )}
        {store.data?.remote && canAllowRemote(store.data) && (
          <AllowRemote remote={store.data.remote} pending={allow.pending} error={allow.error} onAllow={allow.run} />
        )}
      </div>
    </Surface>
  );
}

function StoreDetails({
  dir,
  backup,
  push,
  problem,
}: {
  dir: string;
  backup: string;
  push: ReturnType<typeof localConfigStoreLines>["push"];
  problem: string | null;
}) {
  return (
    <>
      <p className="font-mono text-xs break-all">{dir}</p>
      <p className="text-sm">{backup}</p>
      <span className="text-sm">
        <StatusLabel tone={push.tone} label={push.text} />
      </span>
      {problem && <p className="text-destructive text-xs whitespace-pre-wrap break-words">{problem}</p>}
    </>
  );
}

/** Only the user chooses where the backups go: an agent can change the store's remote, never this setting. */
function AllowRemote({
  remote,
  pending,
  error,
  onAllow,
}: {
  remote: string;
  pending: boolean;
  error: string | undefined;
  onAllow: (remote: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Allow it only if {remote} is your own private repo. If you did not add it, remove it with git (git remote remove origin).
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => onAllow(remote)}>
          Allow pushes to {remote}
        </Button>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    </div>
  );
}
