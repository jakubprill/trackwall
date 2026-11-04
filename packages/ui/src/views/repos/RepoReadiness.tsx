import { READINESS_GAP_LEVEL, type ReadinessGap, type RepoReadiness } from "@trackwall/protocol";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { TaskStartForm } from "@/components/TaskStartForm";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { gapPart, gapPrompt, gapTaskTitle, gapTitle, readinessLine, repoGapFix } from "@/lib/readiness";
import type { SessionSelection } from "@/lib/session-entries";
import { cn } from "@/lib/utils";

const LEVEL_MARKS = {
  blocks: { mark: "×", tone: "text-destructive" },
  weakens: { mark: "!", tone: "text-warning" },
  info: { mark: "·", tone: "text-muted-foreground" },
} as const;

const STATE_TONES = { ready: "text-success", gaps: "text-warning", blocked: "text-destructive" } as const;

/** The card's one line about readiness, in "At a glance" (ADR-201). */
export function ReadinessFact({ readiness }: { readiness: RepoReadiness | undefined }) {
  if (readiness === undefined) return <span className="text-muted-foreground text-sm">checking…</span>;
  return <span className={cn("text-sm", STATE_TONES[readiness.state])}>{readinessLine(readiness)}</span>;
}

/**
 * "Agent readiness" on a repo's card (ADR-201): its gaps, each with what the repo can do about it here: its mise tasks
 * tab, or a task for an agent with a prompt to read first.
 */
export function RepoReadinessSection({
  conn,
  readiness,
  onOpenMiseTasks,
  onOpenInSessions,
}: {
  conn: Connection;
  readiness: RepoReadiness;
  onOpenMiseTasks: () => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  return (
    <Surface label="Agent readiness" meta={<span className={STATE_TONES[readiness.state]}>{readinessLine(readiness)}</span>}>
      {readiness.gaps.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-xs">
          Nothing here stops or weakens an agent: it can build, test and run this repo.
        </p>
      ) : (
        <ul className="divide-y">
          {readiness.gaps.map((gap) => (
            <GapItem
              key={gap.code}
              conn={conn}
              repo={readiness.repo}
              gap={gap}
              onOpenMiseTasks={onOpenMiseTasks}
              onOpenInSessions={onOpenInSessions}
            />
          ))}
        </ul>
      )}
    </Surface>
  );
}

function GapItem({
  conn,
  repo,
  gap,
  onOpenMiseTasks,
  onOpenInSessions,
}: {
  conn: Connection;
  repo: string;
  gap: ReadinessGap;
  onOpenMiseTasks: () => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const [asking, setAsking] = useState(false);
  const { mark, tone } = LEVEL_MARKS[READINESS_GAP_LEVEL[gap.code]];
  const fix = repoGapFix(gap.code);
  return (
    <li className="flex min-w-0 flex-col gap-2 px-3 py-2">
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2">
        <span className={cn("text-center font-mono text-sm", tone)} aria-hidden="true">
          {mark}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm">{gapTitle(gap.code)}</span>
          <span className="text-muted-foreground text-xs break-words">{gap.message}</span>
        </span>
        {fix === "mise" && (
          <Button variant="outline" size="sm" onClick={onOpenMiseTasks}>
            Open mise tasks
          </Button>
        )}
        {fix === "agent" && !asking && (
          <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
            Ask an agent…
          </Button>
        )}
      </div>
      {asking && (
        <TaskStartForm
          conn={conn}
          title={gapTaskTitle(gap.code)}
          legend="Repo to ask"
          promptLabel={`Prompt to close: ${gapTitle(gap.code)}`}
          candidates={[{ part: gapPart({ repo, message: gap.message }), detail: "" }]}
          initialPrompt={gapPrompt(gap.code)}
          onStarted={(selection) => {
            setAsking(false);
            onOpenInSessions(selection);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </li>
  );
}
