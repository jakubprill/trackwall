import { localConfigApi } from "@trackwall/protocol";
import { type ReactNode, useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { planAndKnowledgeDestination, remoteToAllow, workspaceStoreLines } from "@/lib/local-config";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

const POLL_MS = 10_000;

/**
 * The workspace store (ADR-86): where the repos' local config files are backed up, the last backup and the push to
 * the store's remote. The store follows the projects folder, and the user adds a remote with git, then allows it here
 * (ADR-127), since an agent can add one too.
 */
export function WorkspaceStoreSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, localConfigApi.store, {}), [conn]);
  const store = useRemote(load, { pollMs: POLL_MS });
  const allow = useAction((remote: string) => post(conn, localConfigApi.allowRemote, { remote }), store.reload);
  const stop = useAction(() => post(conn, localConfigApi.stopPushing, {}), store.reload);
  const keep = useAction((on: boolean) => post(conn, localConfigApi.keepPlanAndKnowledge, { on }), store.reload);
  const keepSettings = useAction((on: boolean) => post(conn, localConfigApi.keepSettings, { on }), store.reload);
  return (
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
        <StoreDetails dir={store.data.dir} {...workspaceStoreLines(store.data, new Date())} problem={store.data.problem} />
      )}
      {store.data?.pushesTo && (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" disabled={stop.pending} onClick={() => stop.run()}>
            Stop pushing
          </Button>
          {stop.error && <p className="text-destructive text-xs">{stop.error}</p>}
        </div>
      )}
      {store.data?.dir && <AllowRemote offer={remoteToAllow(store.data)} pending={allow.pending} error={allow.error} onAllow={allow.run} />}
      {store.data?.dir && (
        <KeepInStore
          label="Keep Plan and knowledge in the store"
          checked={store.data.keepsPlanAndKnowledge}
          pending={keep.pending}
          error={keep.error}
          onChange={keep.run}
        >
          The store also keeps the knowledge entries and routines in the version you approved, the board and your own task templates, so
          their history is in git and a new computer can get them from the remote. Proposals you have not approved stay out.{" "}
          {planAndKnowledgeDestination(store.data)}
        </KeepInStore>
      )}
      {store.data?.dir && (
        <KeepInStore
          label="Keep Trackwall and Copilot CLI settings in the store"
          checked={store.data.keepsSettings}
          pending={keepSettings.pending}
          error={keepSettings.error}
          onChange={keepSettings.run}
        >
          The store also keeps Trackwall's workspace.yaml and your Copilot CLI settings.json, copilot-instructions.md and mcp-config.json,
          so a new container or computer can get them back. Tokens written into mcp-config.json are masked: only references to environment
          variables go in. {planAndKnowledgeDestination(store.data)}
        </KeepInStore>
      )}
    </div>
  );
}

/**
 * Whether the store also keeps a group of folders: the workspace's knowledge, routines, board and task templates
 * (ADR-298), or the user's settings (ADR-299). Off until the user turns it on, since the store's remote may have been
 * allowed for a few mise files only.
 */
function KeepInStore({
  label,
  checked,
  pending,
  error,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  pending: boolean;
  error: string | undefined;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary size-4 shrink-0"
          checked={checked}
          disabled={pending}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <p className="text-muted-foreground text-xs">{children}</p>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
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
  push: ReturnType<typeof workspaceStoreLines>["push"];
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
  offer,
  pending,
  error,
  onAllow,
}: {
  offer: ReturnType<typeof remoteToAllow>;
  pending: boolean;
  error: string | undefined;
  onAllow: (remote: string) => void;
}) {
  if (offer === null) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        The store's remote is <span className="font-mono text-xs break-all">{offer.remote}</span>, which Trackwall does not push to.
      </p>
      {offer.problem ? (
        <p className="text-destructive text-xs">{offer.problem}</p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Push to it only if you added it yourself and it is your own private repo. If you did not, remove it with git (git remote remove
            origin): Trackwall never pushes to an address you did not choose.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => onAllow(offer.remote)}>
              Push to this remote
            </Button>
            {error && <p className="text-destructive text-xs">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
