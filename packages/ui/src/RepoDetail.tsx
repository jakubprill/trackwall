import { type Repo, type RepoOverview, workspaceApi } from "@pitwall/protocol";
import { Code, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type Remote, useRemote } from "@/lib/use-remote";
import { TabBar } from "./components/TabBar.tsx";
import { RepoCommits } from "./RepoCommits.tsx";
import { RepoFiles } from "./RepoFiles.tsx";
import { RepoStatusBadges } from "./RepoStatusBadges.tsx";

const TABS = [
  { id: "readme", label: "README" },
  { id: "files", label: "Pliki" },
  { id: "commits", label: "Commity" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function RepoDetail({ conn, repo, onRemoved }: { conn: Connection; repo: Repo; onRemoved: () => void }) {
  const [tab, setTab] = useState<Tab>("readme");
  // Nowy commit (np. z terminala) zmienia HEAD w odpytywanej liście, a to pobiera przegląd i drzewo od nowa.
  const head = repo.status.kind === "ok" ? (repo.status.head?.hash ?? "") : undefined;
  const load = useCallback(() => post(conn, workspaceApi.overview, { repo: repo.id }), [conn, repo.id, head]);
  const overview = useRemote(head === undefined ? undefined : load);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold">{repo.id}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">{repo.path}</p>
          <RepoStatusBadges repo={repo} />
        </div>
        <RepoActions conn={conn} repo={repo} onRemoved={onRemoved} />
      </header>

      {repo.status.kind === "unavailable" ? (
        <p className="text-destructive text-sm whitespace-pre-wrap">Repo jest niedostępne: {repo.status.message}</p>
      ) : (
        <>
          <TabBar tabs={TABS} active={tab} onSelect={setTab} variant="underline" />
          {tab === "readme" && <Loaded remote={overview}>{(o) => <Readme readme={o.readme} />}</Loaded>}
          {tab === "commits" && <Loaded remote={overview}>{(o) => <RepoCommits commits={o.commits} />}</Loaded>}
          {tab === "files" && head !== undefined && <RepoFiles conn={conn} repo={repo.id} head={head} />}
        </>
      )}
    </div>
  );
}

function Loaded({ remote, children }: { remote: Remote<RepoOverview>; children: (data: RepoOverview) => ReactNode }) {
  if (remote.error) return <p className="text-destructive text-sm">{remote.error}</p>;
  if (!remote.data) return <p className="text-muted-foreground text-sm">Wczytywanie…</p>;
  return children(remote.data);
}

/**
 * Usunięcie potwierdza się drugim kliknięciem w UI, a nie `window.confirm`: okno WKWebView na macOS
 * nie pokazuje natywnych dialogów JavaScriptu i `confirm` zwraca tam od razu `false`.
 */
function RepoActions({ conn, repo, onRemoved }: { conn: Connection; repo: Repo; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const run = (action: () => Promise<unknown>) => {
    setError(undefined);
    action().catch((err: unknown) => setError(errorMessage(err)));
  };
  const openEditor = () => run(() => post(conn, workspaceApi.openEditor, { repo: repo.id }));
  const remove = () => run(() => post(conn, workspaceApi.remove, { repo: repo.id }).then(onRemoved));

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={openEditor} disabled={repo.status.kind !== "ok"}>
          <Code /> Otwórz w VS Code
        </Button>
        {confirming ? (
          <>
            <Button variant="destructive" size="sm" onClick={remove}>
              Usuń z listy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Anuluj
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label="Usuń z listy">
            <Trash2 />
          </Button>
        )}
      </div>
      {confirming && <p className="text-muted-foreground text-xs">Katalog na dysku zostanie nietknięty.</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function Readme({ readme }: { readme: RepoOverview["readme"] }) {
  if (!readme) return <p className="text-muted-foreground text-sm">To repo nie ma pliku README w ostatnim commicie.</p>;
  return (
    <article className="flex flex-col gap-2">
      <p className="text-muted-foreground font-mono text-xs">{readme.path}</p>
      <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">{readme.text}</pre>
      {readme.truncated && <p className="text-muted-foreground text-xs">Plik jest dłuższy; pokazano początek.</p>}
    </article>
  );
}
