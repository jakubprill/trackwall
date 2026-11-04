import { miseApi, type ReadinessReport, readinessApi } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { TaskStartForm } from "@/components/TaskStartForm";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import {
  type GapGroup,
  gapFix,
  gapPart,
  gapPrompt,
  gapTaskTitle,
  gapTitle,
  gapWhy,
  LEVEL_LABELS,
  readinessCounts,
  readinessGroups,
} from "@/lib/readiness";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

const LEVEL_TONES = { blocks: "text-destructive", weakens: "text-warning", info: "text-muted-foreground" } as const;

/**
 * Agent readiness in the "Overview" view (ADR-201): how many repos have nothing that blocks or weakens agents, and every
 * gap once, with the repos it is in and the one fix for all of them. Nothing changes until the user presses a fix; a
 * task's prompt is read and edited first. Fetched again after a repo change (`refreshKey`), and freshly on "Check again",
 * which also asks mise again about the repos whose commit did not change.
 */
export function ReadinessSection({
  conn,
  refreshKey,
  onSelect,
  onOpenRepo,
  onOpenInSessions,
}: {
  conn: Connection;
  refreshKey: string;
  onSelect: (repo: string) => void;
  onOpenRepo: (repo: string) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  // A fresh check is a one-off: the next load after it asks mise only about repos whose commit changed again.
  const fresh = useRef(false);
  const load = useCallback(() => {
    const body = { fresh: fresh.current };
    fresh.current = false;
    return post(conn, readinessApi.all, body);
  }, [conn]);
  const remote = useRemote(load, { refreshKey });
  const checkAgain = () => {
    fresh.current = true;
    remote.reload();
  };
  const report = remote.data;
  return (
    <Surface
      label="Agent readiness"
      meta={
        <span className="flex items-center gap-2">
          {report && `${readinessCounts(report.repos).ready} of ${report.repos.length} ready`}
          <Button variant="ghost" size="icon" className="size-6" onClick={checkAgain} aria-label="Check readiness again">
            <RefreshCw />
          </Button>
        </span>
      }
    >
      {remote.error && (
        <div className="p-3">
          <ErrorWithRetry message={remote.error} onRetry={remote.reload} />
        </div>
      )}
      {!report && !remote.error && (
        <div className="p-3">
          <Loading text="Asking mise about every repo…" />
        </div>
      )}
      {report && (
        <ReadinessBody
          conn={conn}
          report={report}
          onFixed={checkAgain}
          onSelect={onSelect}
          onOpenRepo={onOpenRepo}
          onOpenInSessions={onOpenInSessions}
        />
      )}
    </Surface>
  );
}

function ReadinessBody({
  conn,
  report,
  onFixed,
  onSelect,
  onOpenRepo,
  onOpenInSessions,
}: {
  conn: Connection;
  report: ReadinessReport;
  onFixed: () => void;
  onSelect: (repo: string) => void;
  onOpenRepo: (repo: string) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const counts = readinessCounts(report.repos);
  const ready = report.repos.filter((r) => r.state === "ready").map((r) => r.repo);
  return (
    <>
      <div className="flex flex-col gap-1.5 border-b px-3 py-2">
        <span className="text-sm">
          <span className="font-mono">{counts.ready}</span> of <span className="font-mono">{report.repos.length}</span> repos ready for
          agents
        </span>
        <div className="bg-secondary flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
          <i className="bg-success" style={{ flexGrow: counts.ready }} />
          <i className="bg-warning" style={{ flexGrow: counts.gaps }} />
          <i className="bg-destructive" style={{ flexGrow: counts.blocked }} />
        </div>
        <span className="text-muted-foreground text-xs">
          {counts.ready} ready · {counts.gaps} with gaps · {counts.blocked} blocked
        </span>
      </div>
      {readinessGroups(report.repos).map(({ level, gaps }) => (
        <section key={level} aria-label={LEVEL_LABELS[level]}>
          <h3 className={cn("hud-label px-3 pt-2", LEVEL_TONES[level])}>{LEVEL_LABELS[level]}</h3>
          <ul className="divide-y">
            {gaps.map((gap) => (
              <GapRow
                key={gap.code}
                conn={conn}
                gap={gap}
                conventionTasks={report.conventionTasks}
                onFixed={onFixed}
                onSelect={onSelect}
                onOpenRepo={onOpenRepo}
                onOpenInSessions={onOpenInSessions}
              />
            ))}
          </ul>
        </section>
      ))}
      {ready.length > 0 && (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">
          Ready:{" "}
          {ready.map((repo) => (
            <button key={repo} type="button" onClick={() => onSelect(repo)} className="text-primary mr-2 font-mono hover:underline">
              {repo}
            </button>
          ))}
        </p>
      )}
    </>
  );
}

function GapRow({
  conn,
  gap,
  conventionTasks,
  onFixed,
  onSelect,
  onOpenRepo,
  onOpenInSessions,
}: {
  conn: Connection;
  gap: GapGroup;
  conventionTasks: ReadinessReport["conventionTasks"];
  onFixed: () => void;
  onSelect: (repo: string) => void;
  onOpenRepo: (repo: string) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const [asking, setAsking] = useState(false);
  const fix = gapFix(gap.code, conventionTasks);
  // A repo name opens what fixes it: the repo for a config to trust or a card to read, the graph's panel for its calls.
  const openRepo = fix === "repo" ? onOpenRepo : onSelect;
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
      <span className="text-sm">{gapTitle(gap.code)}</span>
      <span className="text-muted-foreground text-xs">{gapWhy(gap.code)}</span>
      <ul className="flex flex-col gap-0.5">
        {gap.repos.map((r) => (
          <li key={r.repo} className="flex min-w-0 items-baseline gap-2 text-xs">
            <button type="button" onClick={() => openRepo(r.repo)} className="text-primary shrink-0 font-mono hover:underline">
              {r.repo}
            </button>
            <span className="text-muted-foreground min-w-0 truncate" title={r.message}>
              {r.message}
            </span>
          </li>
        ))}
      </ul>
      {fix === "convention" && <ConventionButton conn={conn} onDone={onFixed} />}
      {fix === "agent" &&
        (asking ? (
          <TaskStartForm
            conn={conn}
            title={gapTaskTitle(gap.code)}
            legend="Repos to ask"
            promptLabel={`Prompt to close: ${gapTitle(gap.code)}`}
            candidates={gap.repos.map((r) => ({ part: gapPart(r), detail: r.message }))}
            initialPrompt={gapPrompt(gap.code)}
            onStarted={(selection) => {
              setAsking(false);
              onOpenInSessions(selection);
            }}
            onCancel={() => setAsking(false)}
          />
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAsking(true)}>
            Ask an agent…
          </Button>
        ))}
    </li>
  );
}

/** Writes the convention tasks file (ADR-157), which gives build and test to every Maven, Gradle and npm repo at once. */
function ConventionButton({ conn, onDone }: { conn: Connection; onDone: () => void }) {
  const write = useAction(() => post(conn, miseApi.writeConventionTasks, {}), onDone);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => write.run()} disabled={write.pending}>
        {write.pending ? "Adding…" : "Add convention tasks"}
      </Button>
      {write.error && <span className="text-destructive text-xs">{write.error}</span>}
    </span>
  );
}
