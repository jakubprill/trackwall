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
import { useDebounced } from "@/lib/use-debounced";
import { useRemote } from "@/lib/use-remote";

/** Wyszukiwanie pyta GitLab po każdej przerwie w pisaniu; krócej to zapytanie przy każdym znaku. */
const SEARCH_DEBOUNCE_MS = 350;
/** Klonowania są w pamięci daemona, więc odpytywanie ich jest tanie, a postęp ma być widać od razu. */
const CLONES_POLL_MS = 1500;

/**
 * Dodawanie repo (ADR-19): wyszukiwarka repo w hostingach z ustawień i klon jednym kliknięciem do folderu
 * z projektami. Po klonie repo pojawia się na liście z folderu samo; `onCloned` tylko ją odświeża od razu.
 */
export function CloneView({ conn, onCloned, onOpenSettings }: { conn: Connection; onCloned: () => void; onOpenSettings: () => void }) {
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
        <span className="hud-label">Dodaj repo</span>
        <h1 className="text-xl font-semibold tracking-tight">Sklonuj z GitLab albo GitHub</h1>
        {remote.data?.projectsDir && <p className="text-muted-foreground font-mono text-xs break-all">do {remote.data.projectsDir}</p>}
      </header>
      <div className="relative flex items-center">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 size-4" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj po nazwie repo albo grupie"
          aria-label="Szukaj repo w hostingach"
          className="pl-9"
        />
      </div>
      {remote.error && <ErrorWithRetry message={remote.error} onRetry={remote.reload} />}
      {!remote.data && !remote.error && <Loading text="Pytam hostingi…" />}
      {remote.data?.projectsDir === null && (
        <NeedsSettings text="Najpierw wskaż folder z projektami: tam trafią sklonowane repo." onOpenSettings={onOpenSettings} />
      )}
      {hosts?.length === 0 && (
        <NeedsSettings
          text="Dodaj w ustawieniach hosting GitLab (adres Twojej instancji) albo GitHub, a tu pojawi się wyszukiwarka jego repo."
          onOpenSettings={onOpenSettings}
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
 * Wywołuje `onDone`, gdy na liście pojawi się zakończone klonowanie, którego jeszcze nie widział; także takie,
 * które skończyło się przed pierwszym odpytaniem i nigdy nie było widać go w stanie `running`.
 */
function useOnCloneDone(jobs: readonly CloneJob[], onDone: () => void) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const done = jobs.filter((j) => j.state === "done").map((j) => `${hostKey(j.host)}/${j.fullName}`);
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
        Otwórz ustawienia
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
            Trackwall pyta hosting przez zalogowany program w systemie. Zaloguj się w terminalu:{" "}
            <span className="text-foreground font-mono text-xs">{loginCommand(host)}</span>
          </p>
        </div>
      </Surface>
    );
  return (
    <Surface
      label={label}
      meta={String(listing.repos.length)}
      note={listing.truncated ? "Hosting ma więcej repo, niż Trackwall pobiera; jeśli czegoś brakuje, zawęź wyszukiwanie." : undefined}
    >
      {listing.repos.length === 0 && <p className="text-muted-foreground p-3 text-sm">Nic nie pasuje.</p>}
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
  if (state.kind === "running") return <StatusLabel tone="warning" label="Klonuję…" />;
  if (state.kind === "done") return <StatusLabel tone="ok" label="Sklonowane" />;
  if (state.kind === "in-projects-dir") return <span className="text-muted-foreground">Już w folderze</span>;
  return (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClone}>
      <Download /> {state.kind === "failed" ? "Spróbuj ponownie" : "Sklonuj"}
    </Button>
  );
}
