import { OpenedResult, RemovedResult, type Repo, RepoOverviewResult, WORKSPACE_ROUTES } from "@pitwall/protocol";
import { ArrowDown, ArrowUp, Code, GitBranch, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { changesLabel } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { RepoCommits } from "./RepoCommits.tsx";
import { RepoFiles } from "./RepoFiles.tsx";

type Tab = "readme" | "files" | "commits";
const TABS: { id: Tab; label: string }[] = [
  { id: "readme", label: "README" },
  { id: "files", label: "Pliki" },
  { id: "commits", label: "Commity" },
];

export function RepoDetail({ conn, repo, onRemoved }: { conn: Connection; repo: Repo; onRemoved: () => void }) {
  const [tab, setTab] = useState<Tab>("readme");
  const [actionError, setActionError] = useState<string>();
  const load = useCallback(() => post(conn, WORKSPACE_ROUTES.overview, { repo: repo.id }, RepoOverviewResult), [conn, repo.id]);
  const { state } = useRemote(load);

  async function act(run: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await run();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const openEditor = () => act(() => post(conn, WORKSPACE_ROUTES.openEditor, { repo: repo.id }, OpenedResult));
  const remove = () =>
    act(async () => {
      if (!window.confirm(`Usunąć ${repo.id} z listy? Katalog na dysku zostanie nietknięty.`)) return;
      await post(conn, WORKSPACE_ROUTES.remove, { repo: repo.id }, RemovedResult);
      onRemoved();
    });

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold">{repo.id}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">{repo.path}</p>
          <RepoStatusLine repo={repo} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void openEditor()} disabled={repo.status.kind !== "ok"}>
            <Code /> Otwórz w VS Code
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void remove()} aria-label="Usuń z listy">
            <Trash2 />
          </Button>
        </div>
      </header>
      {actionError && <p className="text-destructive text-sm">{actionError}</p>}

      {repo.status.kind === "unavailable" ? (
        <p className="text-destructive text-sm whitespace-pre-wrap">Repo jest niedostępne: {repo.status.message}</p>
      ) : (
        <>
          <div className="flex gap-1 border-b" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm",
                  tab === t.id ? "border-foreground font-medium" : "text-muted-foreground border-transparent hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {state.kind === "loading" && tab !== "files" && <p className="text-muted-foreground text-sm">Wczytywanie…</p>}
          {state.kind === "error" && tab !== "files" && <p className="text-destructive text-sm">{state.message}</p>}
          {state.kind === "ok" && tab === "readme" && <Readme readme={state.data.readme} />}
          {state.kind === "ok" && tab === "commits" && <RepoCommits commits={state.data.commits} />}
          {tab === "files" && <RepoFiles conn={conn} repo={repo.id} />}
        </>
      )}
    </div>
  );
}

function RepoStatusLine({ repo }: { repo: Repo }) {
  const { status } = repo;
  if (status.kind !== "ok") return <Badge variant="destructive">niedostępne</Badge>;
  const changes = changesLabel(status.changes);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="flex items-center gap-1 font-mono">
        <GitBranch className="size-3.5" />
        {status.branch ?? "odłączony HEAD"}
      </span>
      {status.upstream && (
        <span className="text-muted-foreground flex items-center gap-1" title={`względem ${status.upstream.name}`}>
          <ArrowUp className="size-3" />
          {status.upstream.ahead}
          <ArrowDown className="size-3" />
          {status.upstream.behind}
        </span>
      )}
      {changes ? <Badge variant="secondary">{changes}</Badge> : <Badge variant="success">czysto</Badge>}
      {status.head === null && <span className="text-muted-foreground">brak commitów</span>}
    </div>
  );
}

function Readme({ readme }: { readme: { path: string; text: string; truncated: boolean } | null }) {
  if (!readme) return <p className="text-muted-foreground text-sm">To repo nie ma pliku README w ostatnim commicie.</p>;
  return (
    <article className="flex flex-col gap-2">
      <p className="text-muted-foreground font-mono text-xs">{readme.path}</p>
      <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">{readme.text}</pre>
      {readme.truncated && <p className="text-muted-foreground text-xs">Plik jest dłuższy; pokazano początek.</p>}
    </article>
  );
}
