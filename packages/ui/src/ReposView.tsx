import { type Repo, RepoResult, ReposResult, WORKSPACE_ROUTES } from "@pitwall/protocol";
import { FolderGit2, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { type Connection, resolveConnection } from "@/lib/connection";
import { changesLabel } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { RepoDetail } from "./RepoDetail.tsx";

/** Stan repo pochodzi z gita przy każdym zapytaniu (§4 `workspace`), więc lista odświeża się cyklicznie. */
const POLL_MS = 10_000;

export function ReposView() {
  const [conn, setConn] = useState<Connection>();
  const [connError, setConnError] = useState<string>();
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    resolveConnection().then(setConn, (err: unknown) => setConnError(String(err)));
  }, []);

  const load = useMemo(() => (conn ? () => post(conn, WORKSPACE_ROUTES.list, {}, ReposResult) : undefined), [conn]);
  const { state, reload } = useRemote(load);

  useEffect(() => {
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  const repos = state.kind === "ok" ? state.data : [];
  const current = repos.find((r) => r.id === selected) ?? repos[0];

  return (
    <div className="grid h-full grid-cols-[18rem_1fr] min-h-0">
      <aside className="flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold">Repo</h2>
          <Button variant="ghost" size="icon" onClick={reload} aria-label="Odśwież listę repo">
            <RefreshCw />
          </Button>
        </div>
        {conn && (
          <AddRepoForm
            conn={conn}
            onAdded={(repo) => {
              setSelected(repo.id);
              reload();
            }}
          />
        )}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {connError && <p className="text-destructive px-2 text-sm">{connError}</p>}
          {state.kind === "error" && <p className="text-destructive px-2 text-sm break-words">{state.message}</p>}
          {state.kind === "ok" && repos.length === 0 && (
            <p className="text-muted-foreground px-2 text-sm">Dodaj pierwsze repo: wklej pełną ścieżkę do katalogu z gitem.</p>
          )}
          {repos.map((repo) => (
            <RepoListItem key={repo.id} repo={repo} active={repo.id === current?.id} onSelect={() => setSelected(repo.id)} />
          ))}
        </nav>
      </aside>
      <section className="min-h-0 min-w-0 overflow-y-auto">
        {conn && current ? (
          <RepoDetail
            key={current.id}
            conn={conn}
            repo={current}
            onRemoved={() => {
              setSelected(undefined);
              reload();
            }}
          />
        ) : (
          <EmptyDetail />
        )}
      </section>
    </div>
  );
}

function AddRepoForm({ conn, onAdded }: { conn: Connection; onAdded: (repo: Repo) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await post(conn, WORKSPACE_ROUTES.add, { path: path.trim() }, RepoResult));
      setPath("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 px-4 pb-3">
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\repo albo /Users/ja/repo"
          aria-label="Ścieżka do repo"
          className="font-mono text-xs"
        />
        <Button type="submit" size="icon" disabled={busy || path.trim() === ""} aria-label="Dodaj repo">
          <Plus />
        </Button>
      </div>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
    </form>
  );
}

function RepoListItem({ repo, active, onSelect }: { repo: Repo; active: boolean; onSelect: () => void }) {
  const { status } = repo;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent", active && "bg-accent")}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{repo.id}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1 pl-6 text-xs">
        {status.kind === "ok" ? (
          <>
            <span className="text-muted-foreground font-mono truncate">{status.branch ?? "odłączony HEAD"}</span>
            {changesLabel(status.changes) && <Badge variant="secondary">{changesLabel(status.changes)}</Badge>}
          </>
        ) : (
          <Badge variant="destructive">niedostępne</Badge>
        )}
      </span>
    </button>
  );
}

function EmptyDetail() {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
      Wybierz repo z listy albo dodaj nowe po lewej.
    </div>
  );
}
