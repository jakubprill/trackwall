import { FileResult, type TreeEntry, TreeResult, WORKSPACE_ROUTES } from "@pitwall/protocol";
import { File, Folder, FolderGit } from "lucide-react";
import { useCallback, useState } from "react";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { breadcrumbs, formatBytes } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/** Drzewo plików z ostatniego commita (daemon czyta HEAD, nie katalog roboczy) i podgląd wybranego pliku. */
export function RepoFiles({ conn, repo }: { conn: Connection; repo: string }) {
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string>();
  const loadTree = useCallback(() => post(conn, WORKSPACE_ROUTES.tree, { repo, path: dir }, TreeResult), [conn, repo, dir]);
  const { state } = useRemote(loadTree);

  const open = (entry: TreeEntry) => {
    if (entry.kind === "dir") {
      setDir(entry.path);
      setFile(undefined);
    } else if (entry.kind === "file") setFile(entry.path);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">Zawartość ostatniego commita; niezacommitowane zmiany nie są tu widoczne.</p>
      <nav className="flex flex-wrap items-center gap-1 font-mono text-sm" aria-label="Ścieżka">
        {breadcrumbs(dir).map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            {i > 1 && <span className="text-muted-foreground">/</span>}
            <button
              type="button"
              className="hover:underline"
              onClick={() => {
                setDir(c.path);
                setFile(undefined);
              }}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="grid grid-cols-[minmax(12rem,20rem)_1fr] gap-4">
        <ul className="divide-y self-start rounded-md border text-sm">
          {state.kind === "loading" && <li className="text-muted-foreground px-3 py-2">Wczytywanie…</li>}
          {state.kind === "error" && <li className="text-destructive px-3 py-2">{state.message}</li>}
          {state.kind === "ok" && state.data.length === 0 && <li className="text-muted-foreground px-3 py-2">Pusto.</li>}
          {state.kind === "ok" &&
            state.data.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => open(entry)}
                  disabled={entry.kind === "submodule"}
                  title={entry.kind === "submodule" ? "Submoduł: dodaj go jako osobne repo, żeby go przeglądać" : entry.path}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent disabled:opacity-60",
                    file === entry.path && "bg-accent",
                  )}
                >
                  <EntryIcon kind={entry.kind} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.size !== undefined && <span className="text-muted-foreground text-xs">{formatBytes(entry.size)}</span>}
                </button>
              </li>
            ))}
        </ul>
        <div className="min-w-0">{file && <FilePreview conn={conn} repo={repo} path={file} />}</div>
      </div>
    </div>
  );
}

function EntryIcon({ kind }: { kind: TreeEntry["kind"] }) {
  if (kind === "dir") return <Folder className="text-muted-foreground size-4 shrink-0" />;
  if (kind === "submodule") return <FolderGit className="text-muted-foreground size-4 shrink-0" />;
  return <File className="text-muted-foreground size-4 shrink-0" />;
}

function FilePreview({ conn, repo, path }: { conn: Connection; repo: string; path: string }) {
  const load = useCallback(() => post(conn, WORKSPACE_ROUTES.file, { repo, path }, FileResult), [conn, repo, path]);
  const { state } = useRemote(load);
  if (state.kind === "loading") return <p className="text-muted-foreground text-sm">Wczytywanie…</p>;
  if (state.kind === "error") return <p className="text-destructive text-sm">{state.message}</p>;
  const content = state.data;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground font-mono text-xs">
        {path} · {formatBytes(content.size)}
      </p>
      {content.kind === "binary" ? (
        <p className="text-muted-foreground text-sm">Plik binarny, bez podglądu.</p>
      ) : (
        <>
          <pre className="bg-muted max-h-[70vh] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">{content.text}</pre>
          {content.truncated && <p className="text-muted-foreground text-xs">Plik jest dłuższy; pokazano początek.</p>}
        </>
      )}
    </div>
  );
}
