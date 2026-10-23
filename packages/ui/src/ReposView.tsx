import { type Repo, workspaceApi } from "@trackwall/protocol";
import { Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { slotNumber } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { RepoDetail } from "./RepoDetail.tsx";
import { RepoStatusBadges, repoHealth } from "./RepoStatusBadges.tsx";

/** Stan repo pochodzi z gita przy każdym zapytaniu (§4.5), więc lista jest odpytywana cyklicznie. */
const POLL_MS = 10_000;

export function ReposView({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const [selected, setSelected] = useState<string>();
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const list = useRemote(load, { pollMs: POLL_MS });

  const repos = list.data ?? [];
  const current = repos.find((r) => r.id === selected) ?? repos[0];

  return (
    <div className="grid h-full min-h-0 grid-cols-[18rem_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">
            Repo <span className="text-primary">{`// ${slotNumber(repos.length)}`}</span>
          </h2>
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
            <RepoListItem key={repo.id} repo={repo} slot={i + 1} active={repo.id === current?.id} onSelect={() => setSelected(repo.id)} />
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
          <div className="hud-label flex h-full items-center justify-center p-6">
            {list.data || list.error ? "Wybierz repo z listy albo dodaj nowe po lewej." : "Wczytywanie…"}
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

/** Wiersz listy jak slot w „banku danych” z inspiracji: numer, kropka stanu, nazwa i gałąź; aktywny ma akcent z lewej. */
function RepoListItem({ repo, slot, active, onSelect }: { repo: Repo; slot: number; active: boolean; onSelect: () => void }) {
  const health = repoHealth(repo);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "relative flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active &&
          "bg-accent border-primary/25 before:bg-primary before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:shadow-[0_0_8px_var(--primary)]",
      )}
    >
      <span className="text-muted-foreground w-5 shrink-0 pt-0.5 text-right font-mono text-[0.6875rem]">{slotNumber(slot)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <StatusDot tone={health.tone} label={health.label} />
          <span className="truncate">{repo.id}</span>
        </span>
        <span className="text-muted-foreground">
          <RepoStatusBadges repo={repo} />
        </span>
      </span>
    </button>
  );
}
