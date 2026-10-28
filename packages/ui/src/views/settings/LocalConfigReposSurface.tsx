import {
  countLabel,
  LOCAL_CONFIG_FILES,
  LOCAL_CONFIG_STORE_DIR,
  localConfigApi,
  type RepoLocalConfig,
  workspaceApi,
} from "@trackwall/protocol";
import { BookOpen, EyeOff, RotateCcw } from "lucide-react";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { docsUrl } from "@/lib/config-files";
import type { Connection } from "@/lib/connection";
import { canIgnore, canRestore, localConfigFileStatus } from "@/lib/local-config";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** What each local config file is for, in the legend above the table. */
const FILE_PURPOSES: Record<(typeof LOCAL_CONFIG_FILES)[number], string> = {
  "mise.local.toml": "your own mise tasks, tools and variables for this repo, on top of mise.toml",
  ".worktreeinclude": "which ignored files a task's worktree gets from the repo",
};

/**
 * The local config of every repo at once (ADR-86, ADR-108): which repos have `mise.local.toml` or `.worktreeinclude`,
 * whether each is backed up and ignored by git, with the same Restore and Ignore locally as the repo's mise tasks tab.
 */
export function LocalConfigReposSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, localConfigApi.repos, {}), [conn]);
  const repos = useRemote(load);
  const docs = useAction(
    () => post(conn, workspaceApi.openLink, { url: docsUrl("local-config") }),
    () => {},
  );
  return (
    <Surface label="Local config in repos" meta={repos.data ? countLabel(repos.data.length, { one: "repo", other: "repos" }) : undefined}>
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-muted-foreground text-xs">
          Files a repo keeps out of git on purpose, only on this computer. Trackwall backs them up to {LOCAL_CONFIG_STORE_DIR} in the
          projects folder and copies them into task worktrees.
        </p>
        <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
          {LOCAL_CONFIG_FILES.map((file) => (
            <li key={file}>
              <code className="text-foreground">{file}</code> {FILE_PURPOSES[file]}
            </li>
          ))}
        </ul>
        <div>
          <Button variant="ghost" size="sm" onClick={docs.run}>
            <BookOpen /> Docs
          </Button>
        </div>
        {docs.error && <p className="text-destructive text-xs">{docs.error}</p>}
      </div>
      {repos.error && <ErrorWithRetry message={repos.error} onRetry={repos.reload} />}
      {!repos.data && !repos.error && <Loading />}
      {repos.data?.length === 0 && <p className="text-muted-foreground border-t px-3 py-2 text-xs">No repo has local config yet.</p>}
      {repos.data && repos.data.length > 0 && (
        <ul className="divide-y border-t">
          {repos.data.map((config) => (
            <RepoRow key={config.repo} conn={conn} config={config} onChange={repos.reload} />
          ))}
        </ul>
      )}
    </Surface>
  );
}

function RepoRow({ conn, config, onChange }: { conn: Connection; config: RepoLocalConfig; onChange: () => void }) {
  const restore = useAction(() => post(conn, localConfigApi.restore, { repo: config.repo }), onChange);
  const ignore = useAction(() => post(conn, localConfigApi.ignore, { repo: config.repo }), onChange);
  return (
    <li className="flex min-w-0 flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{config.repo}</span>
        {canRestore(config) && (
          <Button variant="outline" size="sm" onClick={restore.run} disabled={restore.pending}>
            <RotateCcw /> Restore from the store
          </Button>
        )}
        {canIgnore(config) && (
          <Button variant="outline" size="sm" onClick={ignore.run} disabled={ignore.pending}>
            <EyeOff /> Ignore locally
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {config.files.map((state) => (
          <li key={state.file} className="flex items-center gap-3 text-xs">
            <code className="text-primary w-36 shrink-0">{state.file}</code>
            <StatusLabel {...localConfigFileStatus(state)} />
          </li>
        ))}
      </ul>
      {(restore.error ?? ignore.error) && <p className="text-destructive text-xs">{restore.error ?? ignore.error}</p>}
    </li>
  );
}
