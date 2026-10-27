import { type CloneJob, type HostRepos, hostKey, type RemoteRepo, type RepoHost, workspaceApi } from "@trackwall/protocol";
import { Download, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import { type CloneState, cloneState } from "@/lib/clone-state";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { HOST_KIND_LABEL, loginCommand } from "@/lib/repo-hosts";
import type { SettingsCategory } from "@/lib/settings-categories";
import { useDebounced } from "@/lib/use-debounced";
import { useRemote } from "@/lib/use-remote";

/** The search asks GitLab after every pause in typing; shorter would be a request on every keystroke. */
const SEARCH_DEBOUNCE_MS = 350;
/** Clones are in the daemon's memory, so polling them is cheap, and progress should show at once. */
const CLONES_POLL_MS = 1500;

/**
 * Adding repos (ADR-19): a search for repos on the repo hosts from the settings and a one-click clone into the projects
 * folder. After the clone the repo appears in the folder's list by itself; `onCloned` only refreshes it at once.
 */
export function CloneView({
  conn,
  onCloned,
  onOpenSettings,
}: {
  conn: Connection;
  onCloned: () => void;
  onOpenSettings: (category: SettingsCategory) => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const loadRepos = useCallback(() => post(conn, workspaceApi.remoteRepos, { query: debounced }), [conn, debounced]);
  const remote = useRemote(loadRepos);
  const loadClones = useCallback(() => post(conn, workspaceApi.clones, {}), [conn]);
  const clones = useRemote(loadClones, { pollMs: CLONES_POLL_MS });
  const jobs = clones.data ?? [];
  useOnCloneDone(jobs, onCloned);

  const hosts = remote.data?.hosts;
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="hud-label">Add repo</span>
        <h1 className="text-xl font-semibold tracking-tight">Clone from GitLab or GitHub</h1>
        {remote.data?.projectsDir && <p className="text-muted-foreground font-mono text-xs break-all">into {remote.data.projectsDir}</p>}
      </header>
      <div className="relative flex items-center">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 size-4" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by repo or group name"
          aria-label="Search repos on hosts"
          className="pl-9"
        />
      </div>
      {remote.error && <ErrorWithRetry message={remote.error} onRetry={remote.reload} />}
      {!remote.data && !remote.error && <Loading text="Asking the hosts…" />}
      {remote.data?.projectsDir === null && (
        <NeedsSettings text="Choose the projects folder first: cloned repos go there." onOpenSettings={() => onOpenSettings("workspace")} />
      )}
      {hosts?.length === 0 && (
        <NeedsSettings
          text="Add a GitLab host (your instance address) or GitHub in Settings, and you can search its repos here."
          onOpenSettings={() => onOpenSettings("repo-hosts")}
        />
      )}
      {hosts?.map((h) => (
        <HostSection
          key={hostKey(h.host)}
          conn={conn}
          hostRepos={h}
          jobs={jobs}
          canClone={remote.data?.projectsDir !== null}
          onStarted={clones.reload}
        />
      ))}
    </div>
  );
}

/**
 * Calls `onDone` when a finished clone it has not seen yet appears in the list; also one that finished before the first
 * poll and was never seen in the `running` state.
 */
function useOnCloneDone(jobs: readonly CloneJob[], onDone: () => void) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    // A clone's path is unique to the clone; the same repo can be cloned again into another folder.
    const done = jobs.filter((j) => j.state === "done").map((j) => j.path);
    const fresh = done.filter((key) => !seen.current.has(key));
    for (const key of fresh) seen.current.add(key);
    if (fresh.length > 0) onDone();
  }, [jobs, onDone]);
}

function NeedsSettings({ text, onOpenSettings }: { text: string; onOpenSettings: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-sm">{text}</p>
      <Button variant="outline" size="sm" onClick={onOpenSettings}>
        Open settings
      </Button>
    </div>
  );
}

function HostSection({
  conn,
  hostRepos,
  jobs,
  canClone,
  onStarted,
}: {
  conn: Connection;
  hostRepos: HostRepos;
  jobs: readonly CloneJob[];
  canClone: boolean;
  onStarted: () => void;
}) {
  const { host, listing } = hostRepos;
  const label = `${HOST_KIND_LABEL[host.kind]} // ${host.host}`;
  if (listing.kind === "unavailable")
    return (
      <Surface label={label}>
        <div className="flex flex-col gap-2 p-3 text-sm">
          <p className="text-destructive whitespace-pre-wrap break-words">{listing.message}</p>
          <p className="text-muted-foreground">
            Trackwall asks the host through the CLI you are signed in to. Sign in from a terminal:{" "}
            <span className="text-foreground font-mono text-xs">{loginCommand(host)}</span>
          </p>
        </div>
      </Surface>
    );
  return (
    <Surface
      label={label}
      meta={String(listing.repos.length)}
      note={listing.truncated ? "The host has more repos than Trackwall fetches; if something is missing, narrow the search." : undefined}
    >
      {listing.repos.length === 0 && <p className="text-muted-foreground p-3 text-sm">No matches.</p>}
      <ul className="divide-y">
        {listing.repos.map((repo) => (
          <RemoteRepoRow
            key={repo.fullName}
            conn={conn}
            host={host}
            repo={repo}
            state={cloneState(host, repo, jobs)}
            canClone={canClone}
            onStarted={onStarted}
          />
        ))}
      </ul>
    </Surface>
  );
}

function RemoteRepoRow({
  conn,
  host,
  repo,
  state,
  canClone,
  onStarted,
}: {
  conn: Connection;
  host: RepoHost;
  repo: RemoteRepo;
  state: CloneState;
  canClone: boolean;
  onStarted: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function clone() {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.clone, { host, fullName: repo.fullName });
      onStarted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const failure = error ?? (state.kind === "failed" ? state.message : undefined);
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-sm" title={repo.webUrl}>
          {repo.fullName}
        </span>
        {repo.description && <span className="text-muted-foreground truncate text-xs">{repo.description}</span>}
        {repo.updatedAt && <span className="text-muted-foreground text-2xs font-mono">{relativeTime(repo.updatedAt, new Date())}</span>}
        {failure && <span className="text-destructive text-xs whitespace-pre-wrap break-words">{failure}</span>}
      </div>
      <span className="shrink-0 pt-0.5 text-xs">
        <CloneAction state={state} disabled={busy || !canClone} onClone={() => void clone()} />
      </span>
    </li>
  );
}

function CloneAction({ state, disabled, onClone }: { state: CloneState; disabled: boolean; onClone: () => void }) {
  if (state.kind === "running") return <StatusLabel tone="warning" label="Cloning…" />;
  if (state.kind === "done") return <StatusLabel tone="ok" label="Cloned" />;
  if (state.kind === "in-projects-dir") return <span className="text-muted-foreground">Already in the folder</span>;
  return (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClone}>
      <Download /> {state.kind === "failed" ? "Try again" : "Clone"}
    </Button>
  );
}
