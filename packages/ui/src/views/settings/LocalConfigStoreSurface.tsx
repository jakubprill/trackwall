import { localConfigApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { localConfigStoreLines } from "@/lib/local-config";
import { useRemote } from "@/lib/use-remote";

const POLL_MS = 10_000;

/**
 * The local config store (ADR-86): where the repos' local config files are backed up, the last backup and the push to
 * the store's remote. Nothing to set: the store follows the projects folder, and the user adds a remote with git.
 */
export function LocalConfigStoreSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, localConfigApi.store, {}), [conn]);
  const store = useRemote(load, { pollMs: POLL_MS });
  return (
    <Surface label="Local config store">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Trackwall backs up each repo's mise.local.toml and .worktreeinclude, files you keep out of git, into a git repo in your projects
          folder, and restores them into a new clone. To keep a copy off this computer, add a remote to that repo with git (git remote add
          origin …): Trackwall pushes every backup to it.
        </p>
        {store.error && <ErrorWithRetry message={store.error} onRetry={store.reload} />}
        {!store.data && !store.error && <Loading />}
        {store.data?.dir === null && <p className="text-sm">Set the projects folder first.</p>}
        {store.data?.dir && (
          <StoreDetails dir={store.data.dir} {...localConfigStoreLines(store.data, new Date())} problem={store.data.problem} />
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
