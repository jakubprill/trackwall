import { type Repo, workspaceApi } from "@trackwall/protocol";
import { Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { twoDigits } from "@/lib/format";
import { branchLabel, repoStatusTone } from "@/lib/repo-status";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { RepoDetail } from "./RepoDetail.tsx";

/** Stan repo pochodzi z gita przy każdym zapytaniu (§4.5), więc lista jest odpytywana cyklicznie. */
const POLL_MS = 10_000;

export function ReposView({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const [selected, setSelected] = useState<string>();
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const list = useRemote(load, { pollMs: POLL_MS });

  const repos = list.data ?? [];
  const current = repos.find((r) => r.id === selected) ?? repos[0];

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">Repo {list.data && <span className="text-primary">{`// ${twoDigits(list.data.length)}`}</span>}</h2>
          <Button variant="ghost" size="icon" onClick={list.reload} aria-label="Odśwież listę repo">
            <RefreshCw />
          </Button>
        </div>
        <AddRepoForm
          conn={conn}
          onAdded={(repo) => {
            setSelected(repo.id);
            list.reload();
          }}
        />
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {list.error && (
            <div className="flex flex-col items-start gap-2 px-2 pb-2">
              <p className="text-destructive text-sm break-words">{list.error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onRetry();
                  list.reload();
                }}
              >
                Spróbuj ponownie
              </Button>
            </div>
          )}
          {list.data?.length === 0 && (
            <p className="text-muted-foreground px-2 text-sm">Dodaj pierwsze repo: wklej pełną ścieżkę do katalogu z gitem.</p>
          )}
          {repos.map((repo, i) => (
            <RepoListItem
              key={repo.id}
              repo={repo}
              position={i + 1}
              active={repo.id === current?.id}
              onSelect={() => setSelected(repo.id)}
            />
          ))}
        </nav>
      </aside>
      <section className="min-h-0 min-w-0 overflow-y-auto">
        {current ? (
          <RepoDetail
            key={current.id}
            conn={conn}
            repo={current}
            onRemoved={() => {
              setSelected(undefined);
              list.reload();
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            {list.data || list.error ? (
              <p className="text-muted-foreground text-sm">Wybierz repo z listy albo dodaj nowe po lewej.</p>
            ) : (
              <Loading />
            )}
          </div>
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
      onAdded(await post(conn, workspaceApi.add, { path: path.trim() }));
      setPath("");
    } catch (err) {
      setError(errorMessage(err));
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

/**
 * Wiersz listy w stylu HUD (ADR-16): numer pozycji, nazwa, gałąź oraz kropka i tekst stanu; aktywny ma świecącą kreskę z lewej.
 * Numer to tylko pozycja na liście, nie identyfikator repo.
 */
function RepoListItem({ repo, position, active, onSelect }: { repo: Repo; position: number; active: boolean; onSelect: () => void }) {
  const { status } = repo;
  const state = repoStatusTone(status);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <span className="text-muted-foreground text-2xs w-5 shrink-0 pt-0.5 text-right font-mono">{twoDigits(position)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">{repo.id}</span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          {status.kind === "ok" && <span className="min-w-0 truncate font-mono">{branchLabel(status)}</span>}
          <StatusLabel tone={state.tone} label={state.label} />
        </span>
      </span>
    </button>
  );
}
