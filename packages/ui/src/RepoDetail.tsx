import { type Repo, type RepoOverview, workspaceApi } from "@trackwall/protocol";
import { Code, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { TRUNCATED_NOTE } from "@/lib/format";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { RepoCommits } from "./RepoCommits.tsx";
import { RepoFiles } from "./RepoFiles.tsx";
import { RepoStats } from "./RepoStats.tsx";
import { TabBar } from "./TabBar.tsx";

const TABS = [
  { id: "readme", label: "README" },
  { id: "files", label: "Pliki" },
  { id: "commits", label: "Commity" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function RepoDetail({ conn, repo, onRemoved }: { conn: Connection; repo: Repo; onRemoved: () => void }) {
  const [tab, setTab] = useState<Tab>("readme");
  const { status } = repo;
  const available = status.kind === "ok";
  // Nowy commit (np. z terminala) zmienia HEAD w odpytywanej liście, a to pobiera przegląd i drzewo od nowa.
  const head = status.kind === "ok" ? (status.head?.hash ?? "") : "";
  const load = useCallback(() => post(conn, workspaceApi.overview, { repo: repo.id }), [conn, repo.id]);
  const overview = useRemote(available ? load : undefined, { refreshKey: head });

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="hud-label">Repo</span>
          <h1 className="text-xl font-semibold tracking-tight">{repo.id}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">{repo.path}</p>
        </div>
        <RepoActions conn={conn} repo={repo} onRemoved={onRemoved} />
      </header>
      {status.kind === "unavailable" ? (
        <p className="text-destructive text-sm whitespace-pre-wrap">Repo jest niedostępne: {status.message}</p>
      ) : (
        <>
          <RepoStats status={status} />
          <TabBar tabs={TABS} active={tab} onSelect={setTab} variant="underline" />
          {tab === "readme" && <Loaded remote={overview}>{(o) => <Readme readme={o.readme} />}</Loaded>}
          {tab === "commits" && <Loaded remote={overview}>{(o) => <RepoCommits commits={o.commits} />}</Loaded>}
          {tab === "files" && <RepoFiles conn={conn} repo={repo.id} head={head} />}
        </>
      )}
    </div>
  );
}

function Loaded({ remote, children }: { remote: RemoteHandle<RepoOverview>; children: (data: RepoOverview) => ReactNode }) {
  if (remote.error)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-destructive text-sm">{remote.error}</p>
        <Button variant="outline" size="sm" onClick={remote.reload}>
          Spróbuj ponownie
        </Button>
      </div>
    );
  if (!remote.data) return <Loading />;
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
    <Surface path={readme.path} note={readme.truncated ? TRUNCATED_NOTE : undefined}>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">{readme.text}</pre>
    </Surface>
  );
}
