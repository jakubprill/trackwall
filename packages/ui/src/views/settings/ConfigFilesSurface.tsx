import {
  CONFIG_ENTRIES,
  type ConfigEntry,
  configFilesApi,
  type DocsPage,
  type UnknownWorkspaceKey,
  WORKSPACE_KEYS,
  type WorkspaceKeyState,
} from "@trackwall/protocol";
import { BookOpen, Code, FolderOpen } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import {
  type ConfigGroup,
  configEntryStatus,
  configGroups,
  configProblemCount,
  configWriterLabel,
  docsUrl,
  workspaceKeyChangedIn,
} from "@/lib/config-files";
import type { Connection } from "@/lib/connection";
import { NO_DESKTOP_NOTE, useDesktop, useOpenWebLink } from "@/lib/desktop";
import { FILE_MANAGER } from "@/lib/platform";
import { useRemote } from "@/lib/use-remote";

/**
 * The config files (ADR-108): every file and folder Trackwall reads or writes, grouped by where it lies, each with what it
 * is for, a link to its documentation page and its state, and the keys of `workspace.yaml` with their values. It only
 * reads; "Open" and "Show" go through the daemon, which picks the path from its own list.
 */
export function ConfigFilesSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, configFilesApi.list, {}), [conn]);
  const report = useRemote(load);
  const [error, setError] = useState<string>();
  const act = (request: Promise<unknown>) => {
    setError(undefined);
    request.catch((err: unknown) => setError(errorMessage(err)));
  };
  const desktop = useDesktop();
  const openLink = useOpenWebLink(conn);
  const actions: EntryActions = {
    desktop,
    open: (id) => act(post(conn, configFilesApi.openInEditor, { id })),
    show: (id) => act(post(conn, configFilesApi.showInFolder, { id })),
    docs: (page) => act(openLink(docsUrl(page))),
  };
  const problems = report.data && configProblemCount(report.data);
  return (
    <div className="flex flex-col gap-4">
      {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
      {!report.data && !report.error && <Loading />}
      {error && <p className="text-destructive text-xs">{error}</p>}
      {!desktop && <p className="text-muted-foreground text-xs">{NO_DESKTOP_NOTE}</p>}
      {report.data &&
        configGroups(report.data).map((group) => (
          <Surface
            key={group.place}
            label={group.title}
            meta={group.place === "state" && problems ? `${problems} to fix` : undefined}
            note={group.place === "state" ? HIDDEN_FILES : undefined}
          >
            <GroupHeader group={group} />
            <ul className="divide-y border-t">
              {group.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} actions={actions}>
                  {entry.id === "workspace-file" && report.data && (
                    <WorkspaceKeys keys={report.data.workspaceKeys} unknown={report.data.unknownWorkspaceKeys} onDocs={actions.docs} />
                  )}
                </EntryRow>
              ))}
            </ul>
            {group.internal.length > 0 && <InternalEntries entries={group.internal} actions={actions} />}
          </Surface>
        ))}
      {report.data && (
        <div>
          <Button variant="outline" size="sm" onClick={report.reload}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Why the files with the daemon token are not in the list (§8). */
const HIDDEN_FILES =
  "daemon.json and each session's files hold the key the app and sessions use to reach Trackwall, so they are not listed.";

interface EntryActions {
  /** Whether the daemon can open a file or a folder on this computer (ADR-120); without it those buttons are hidden. */
  desktop: boolean;
  open: (id: ConfigEntry["id"]) => void;
  show: (id: ConfigEntry["id"]) => void;
  docs: (page: DocsPage) => void;
}

function GroupHeader({ group }: { group: ConfigGroup }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <p className="text-muted-foreground text-xs">{group.description}</p>
      <p className="font-mono text-xs break-all">{group.dir ?? "Set the projects folder in Settings › Workspace."}</p>
    </div>
  );
}

function EntryRow({ entry, actions, children }: { entry: ConfigEntry; actions: EntryActions; children?: ReactNode }) {
  const info = CONFIG_ENTRIES[entry.id];
  const there = entry.state !== "missing" && entry.path !== null;
  return (
    <li className="flex min-w-0 flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="text-primary text-xs">{entry.name}</code>
        <span className="text-muted-foreground text-xs">by {configWriterLabel(entry)}</span>
        <span className="text-xs">
          <StatusLabel {...configEntryStatus(entry)} />
        </span>
      </div>
      <p className="text-sm">{info.purpose}</p>
      {entry.detail && (
        <p className={entry.state === "invalid" ? "text-destructive text-xs break-words" : "text-muted-foreground text-xs break-words"}>
          {entry.detail}
        </p>
      )}
      {entry.path && <p className="text-muted-foreground font-mono text-xs break-all">{entry.path}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {info.kind === "file" && there && actions.desktop && (
          <Button variant="outline" size="sm" onClick={() => actions.open(entry.id)}>
            <Code /> Open in VS Code
          </Button>
        )}
        {there && actions.desktop && (
          <Button variant="outline" size="sm" onClick={() => actions.show(entry.id)}>
            <FolderOpen /> Show in {FILE_MANAGER}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => actions.docs(info.docs)}>
          <BookOpen /> Docs
        </Button>
      </div>
      {children}
    </li>
  );
}

function WorkspaceKeys({
  keys,
  unknown,
  onDocs,
}: {
  keys: WorkspaceKeyState[];
  unknown: UnknownWorkspaceKey[];
  onDocs: (page: DocsPage) => void;
}) {
  if (keys.length === 0) return null;
  return (
    <table className="mt-2 w-full text-xs">
      <thead className="text-muted-foreground text-left">
        <tr>
          <th className="py-1 pr-3 font-medium">Key</th>
          <th className="py-1 pr-3 font-medium">Value</th>
          <th className="py-1 font-medium">Changed in</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {keys.map((k) => (
          <tr key={k.key} className="align-top">
            <td className="py-1.5 pr-3">
              <code className={k.problem ? "text-destructive" : "text-primary"}>{k.key}</code>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground block text-left"
                onClick={() => onDocs(WORKSPACE_KEYS[k.key].docs)}
              >
                {WORKSPACE_KEYS[k.key].purpose}
              </button>
            </td>
            <td className="py-1.5 pr-3 break-all">
              {k.problem ? (
                <span className="text-destructive">{k.line === null ? k.problem : `line ${k.line}: ${k.problem}`}</span>
              ) : (
                <>
                  {k.value} {k.from === "default" && <span className="text-muted-foreground">(default)</span>}
                </>
              )}
            </td>
            <td className="text-muted-foreground py-1.5">{workspaceKeyChangedIn(k.key)}</td>
          </tr>
        ))}
        {unknown.map((k) => (
          <tr key={`unknown-${k.name}`} className="align-top">
            <td className="py-1.5 pr-3">
              <code className="text-warning">{k.name}</code>
            </td>
            <td className="text-warning py-1.5 pr-3" colSpan={2}>
              {k.line === null ? "" : `line ${k.line}: `}Trackwall does not read this key. Check its spelling, or remove it.
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InternalEntries({ entries, actions }: { entries: ConfigEntry[]; actions: EntryActions }) {
  return (
    <details className="border-t">
      <summary className="cursor-pointer px-3 py-2 text-xs">
        {entries.length} files and folders Trackwall keeps for itself{" "}
        <span className="text-muted-foreground">· it rewrites them, so do not edit them</span>
      </summary>
      <ul className="divide-y border-t">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} actions={actions} />
        ))}
      </ul>
    </details>
  );
}
