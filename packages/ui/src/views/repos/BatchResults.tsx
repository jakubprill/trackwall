import type { BatchRepo, BatchRun } from "@trackwall/protocol";
import { countLabel } from "@trackwall/protocol";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { batchProgress, batchRunLabel, STEP_LABEL, stepLabel, stepMessage } from "@/lib/batch-state";
import type { Connection } from "@/lib/connection";
import { reposSkippedForChanges } from "@/lib/put-aside";
import { PutAsideConfirm } from "./PutAsideConfirm.tsx";

/**
 * The result of every step in every repo of the batch command (ADR-27). A skipped sync shows its reason, and one skipped
 * only for changed tracked files can put them aside and sync (ADR-270), per repo or for all such repos at once.
 */
export function BatchResults({
  conn,
  run,
  workInFolder,
}: {
  conn: Connection;
  run: BatchRun;
  workInFolder: (repo: string) => readonly string[];
}) {
  const progress = batchProgress(run);
  const [putAside, setPutAside] = useState<readonly string[]>([]);
  const skipped = run.finishedAt === null ? [] : reposSkippedForChanges(run);
  return (
    <Surface
      label={batchRunLabel(run, new Date())}
      meta={`${progress.done}/${progress.total}`}
      note={progress.failed > 0 ? `Repos with errors: ${progress.failed}` : undefined}
    >
      {putAside.length > 0 ? (
        <div className="border-b p-3">
          <PutAsideConfirm
            conn={conn}
            targets={putAside.map((repo) => ({ repo, workInFolder: workInFolder(repo) }))}
            verb="sync"
            onClose={() => setPutAside([])}
          />
        </div>
      ) : (
        skipped.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
            <span className="text-warning">
              Sync skipped in {countLabel(skipped.length, { one: "repo", other: "repos" })} because of changed files.
            </span>
            <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => setPutAside(skipped)}>
              Put aside the changes in {skipped.length} repos and sync…
            </Button>
          </div>
        )
      )}
      <ul className="divide-y">
        {run.repos.map((repo) => (
          <ResultRow
            key={repo.path}
            repo={repo}
            onPutAside={skipped.includes(repo.repo) && putAside.length === 0 ? () => setPutAside([repo.repo]) : undefined}
          />
        ))}
      </ul>
    </Surface>
  );
}

/** `onPutAside` only for a finished repo whose sync was skipped for changed files. */
function ResultRow({ repo, onPutAside }: { repo: BatchRepo; onPutAside: (() => void) | undefined }) {
  const sync = repo.steps.find((s) => s.step === "sync");
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <span className="truncate font-mono text-sm" title={repo.path}>
        {repo.repo}
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {repo.steps.map((step) => {
          const { tone, label } = stepLabel(step);
          return (
            <span key={step.step} className="flex items-center gap-2" title={stepMessage(step)}>
              <span className="text-muted-foreground">{STEP_LABEL[step.step]}</span>
              {tone ? <StatusLabel tone={tone} label={label} /> : <span>{label}</span>}
            </span>
          );
        })}
      </div>
      {sync?.state === "skipped" && sync.syncReason !== null && (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className={onPutAside ? "text-warning" : "text-muted-foreground"}>{sync.message}</span>
          {onPutAside && (
            <Button variant="outline" size="sm" className="ml-auto h-7" onClick={onPutAside}>
              Put aside and sync…
            </Button>
          )}
        </span>
      )}
      {repo.steps.map((step) =>
        step.state === "failed" ? (
          <div key={step.step} className="flex flex-col gap-1">
            <span className="text-destructive text-xs whitespace-pre-wrap break-words">
              {STEP_LABEL[step.step]}: {step.message}
            </span>
            {step.lastLines.length > 0 && (
              <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
                {step.lastLines.join("\n")}
              </pre>
            )}
          </div>
        ) : null,
      )}
    </li>
  );
}
