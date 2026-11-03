import { DOWNLOAD_PATH, type FolderEntry, MAX_DOWNLOAD_BYTES, type TerminalPlace, terminalsApi } from "@trackwall/protocol";
import { Download, File, Folder, Link, RotateCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { download, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { entryAction, entryPath, saveFile } from "@/lib/folder-files";
import { breadcrumbs, formatBytes } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The "Files on disk" panel of the Shell tab (ADR-188): the place's folder as it is now, uncommitted files and build output too,
 * read only. A folder opens on click, a file downloads to the user's computer, which is how a JAR or a log leaves a
 * container. Links are listed and never followed.
 */
export function FolderFiles({ conn, place }: { conn: Connection; place: TerminalPlace }) {
  const { repo, task } = place;
  const [dir, setDir] = useState("");
  // By the place's ids: the tab hands a new object at every render.
  const load = useCallback(() => post(conn, terminalsApi.files, { repo, task, path: dir }), [conn, repo, task, dir]);
  const listing = useRemote(load);
  const save = useAction(
    async (entry: FolderEntry) => ({
      name: entry.name,
      blob: await download(conn, DOWNLOAD_PATH, { repo, task, path: entryPath(dir, entry.name) }),
    }),
    ({ name, blob }) => saveFile(blob, name),
  );

  return (
    <div className="flex min-h-0 flex-col border-l">
      <div className="flex items-center gap-1 border-b px-3 py-1">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 font-mono text-xs" aria-label="Folder">
          {breadcrumbs(dir).map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 1 && <span className="text-muted-foreground">/</span>}
              <button type="button" className="hover:text-primary" onClick={() => setDir(c.path)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <Button variant="ghost" size="icon" onClick={listing.reload} title="Read the folder again" aria-label="Read the folder again">
          <RotateCw />
        </Button>
      </div>
      {save.error && <p className="text-destructive px-3 py-1 text-xs">{save.error}</p>}
      <ul className="min-h-0 flex-1 divide-y overflow-auto text-sm">
        {listing.error && <li className="text-destructive px-3 py-2">{listing.error}</li>}
        {!listing.data && !listing.error && (
          <li className="px-3 py-2">
            <Loading />
          </li>
        )}
        {listing.data?.entries.length === 0 && <li className="text-muted-foreground px-3 py-2">Empty.</li>}
        {listing.data?.entries.map((entry) => (
          <li key={entry.name}>
            <EntryRow
              entry={entry}
              saving={save.pending}
              onOpen={() => setDir(entryPath(dir, entry.name))}
              onDownload={() => save.run(entry)}
            />
          </li>
        ))}
        {listing.data?.truncated && (
          <li className="text-muted-foreground px-3 py-2 text-xs">More entries than shown; open a shell to see them all.</li>
        )}
      </ul>
    </div>
  );
}

function EntryRow({
  entry,
  saving,
  onOpen,
  onDownload,
}: {
  entry: FolderEntry;
  saving: boolean;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const action = entryAction(entry);
  const tooLarge = entry.size !== null && entry.size > MAX_DOWNLOAD_BYTES;
  const title =
    action === null
      ? `${entry.name}: ${entry.kind === "link" ? "a link, which is not followed" : "not a file or folder"}`
      : tooLarge
        ? `${entry.name} is larger than ${formatBytes(MAX_DOWNLOAD_BYTES)}; copy it out with docker cp`
        : action === "open"
          ? entry.name
          : `Download ${entry.name}`;
  return (
    <button
      type="button"
      onClick={action === "open" ? onOpen : onDownload}
      disabled={action === null || tooLarge || (action === "download" && saving)}
      title={title}
      className="focus-visible:ring-ring group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset disabled:opacity-60"
    >
      <EntryIcon entry={entry} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.size !== null && <span className="text-muted-foreground font-mono text-xs">{formatBytes(entry.size)}</span>}
      {action === "download" && <Download className="text-muted-foreground size-3.5 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

function EntryIcon({ entry }: { entry: FolderEntry }) {
  if (entry.kind === "folder") return <Folder className="text-muted-foreground size-4 shrink-0" />;
  if (entry.kind === "link") return <Link className="text-muted-foreground size-4 shrink-0" />;
  return <File className="text-muted-foreground size-4 shrink-0" />;
}
