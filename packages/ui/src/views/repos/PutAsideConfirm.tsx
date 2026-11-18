import { countLabel, type PullResult, type PutAsideFile, workspaceApi } from "@trackwall/protocol";
import { useEffect, useState } from "react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { putAsideResultLine } from "@/lib/put-aside";
import { folderWorkWarning } from "@/lib/upstream-pull";

/** A repo to put changes aside in, with what works in its folder itself (`workInRepoFolder`), which leaves it out. */
export interface PutAsideTarget {
  repo: string;
  workInFolder: readonly string[];
}

type RepoOutcome = { kind: "pulled"; result: PullResult } | { kind: "failed"; message: string };

/**
 * The question before changes are put aside to pull (ADR-271), in the Upstream tile and in the batch command's results:
 * every file that leaves the working directory, per repo, and where the changes go. A repo where a session or mise task
 * works in the folder itself is left out with the reason. The repos are pulled one after another, each with its result.
 */
export function PutAsideConfirm({
  conn,
  targets,
  verb,
  onClose,
}: {
  conn: Connection;
  targets: readonly PutAsideTarget[];
  /** "pull" in the repo header, "sync" in the batch command, so the button says what the user started from. */
  verb: "pull" | "sync";
  onClose: () => void;
}) {
  const ready = targets.filter((t) => t.workInFolder.length === 0);
  const [files, setFiles] = useState<ReadonlyMap<string, PutAsideFile[] | string>>();
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, RepoOutcome>>(new Map());
  const [running, setRunning] = useState(false);
  const repoKey = ready.map((t) => t.repo).join("\0");

  useEffect(() => {
    const repos = repoKey === "" ? [] : repoKey.split("\0");
    let live = true;
    void Promise.all(
      repos.map((repo) =>
        post(conn, workspaceApi.putAsideFiles, { repo }).then(
          (list): [string, PutAsideFile[] | string] => [repo, list],
          (err: unknown): [string, PutAsideFile[] | string] => [repo, errorMessage(err)],
        ),
      ),
    ).then((entries) => {
      if (live) setFiles(new Map(entries));
    });
    return () => {
      live = false;
    };
  }, [conn, repoKey]);

  const start = async () => {
    setRunning(true);
    for (const { repo } of ready) {
      const outcome = await post(conn, workspaceApi.pull, { repo, putAside: true }).then(
        (result): RepoOutcome => ({ kind: "pulled", result }),
        (err: unknown): RepoOutcome => ({ kind: "failed", message: errorMessage(err) }),
      );
      setOutcomes((current) => new Map(current).set(repo, outcome));
    }
    setRunning(false);
  };
  const finished = outcomes.size === ready.length && !running;
  const title = `Put aside the changes and ${verb} ${countLabel(ready.length, { one: "repo", other: "repos" })}?`;

  return (
    <section aria-label="Put aside the changes" className="surface flex min-w-0 flex-col gap-3 p-3 text-sm">
      <span className="font-semibold">{finished ? "Changes put aside" : title}</span>
      <p className="text-muted-foreground text-xs">
        The changes in tracked files leave the working directory and go to a git stash; new files stay where they are. You can bring them
        back from the repo's Changes tab or with <code>git stash pop</code>.
      </p>
      {files === undefined ? (
        <Loading />
      ) : (
        <ul className="divide-y rounded-md border">
          {targets.map((t) => (
            <TargetRow key={t.repo} target={t} files={files.get(t.repo)} outcome={outcomes.get(t.repo)} />
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        {finished ? (
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={running} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={running || files === undefined || ready.length === 0} onClick={() => void start()}>
              {running ? "Putting aside…" : `Put aside and ${verb}`}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function TargetRow({
  target,
  files,
  outcome,
}: {
  target: PutAsideTarget;
  files: PutAsideFile[] | string | undefined;
  outcome: RepoOutcome | undefined;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 px-3 py-2">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono">{target.repo}</span>
        {Array.isArray(files) && (
          <span className="text-muted-foreground text-xs">{countLabel(files.length, { one: "file", other: "files" })}</span>
        )}
      </span>
      {target.workInFolder.length > 0 && <span className="text-warning text-xs">Left out: {folderWorkWarning(target.workInFolder)}</span>}
      {typeof files === "string" && <span className="text-destructive text-xs">{files}</span>}
      {Array.isArray(files) && (
        <ul className="font-mono text-xs">
          {files.map((f) => (
            <li key={f.path} className="flex min-w-0 gap-2">
              <span className="text-warning">{f.change[0]?.toUpperCase()}</span>
              <span className="min-w-0 truncate" title={f.path}>
                {f.path}
              </span>
            </li>
          ))}
        </ul>
      )}
      {outcome?.kind === "pulled" && <StatusLabel {...putAsideResultLine(outcome.result)} className="text-xs whitespace-normal" />}
      {outcome?.kind === "failed" && <span className="text-destructive text-xs break-words">{outcome.message}</span>}
    </li>
  );
}
