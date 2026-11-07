import { READINESS_GAP_LEVEL, type ReadinessGap, type RepoReadiness } from "@trackwall/protocol";
import { useState } from "react";
import { MiseFormatButton } from "@/components/MiseFormatButton";
import { Surface } from "@/components/Surface";
import { TaskStartForm } from "@/components/TaskStartForm";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { gapPart, gapPrompt, gapTaskTitle, gapTitle, LEVEL_TONES, readinessLine, repoGapFix, STATE_TONES } from "@/lib/readiness";
import type { SessionSelection } from "@/lib/session-entries";
import { cn } from "@/lib/utils";

const LEVEL_MARKS = { blocks: "×", weakens: "!", info: "·" } as const;

/** The card's one line about readiness, in "At a glance" (ADR-208). */
export function ReadinessFact({ readiness }: { readiness: RepoReadiness | undefined }) {
  if (readiness === undefined) return <span className="text-muted-foreground text-sm">checking…</span>;
  return <span className={cn("text-sm", STATE_TONES[readiness.state])}>{readinessLine(readiness)}</span>;
}

/**
 * "Agent readiness" on a repo's card (ADR-208): its gaps, each with what the repo can do about it here: its mise tasks
 * tab, "Format" for a config mise would format, or a task for an agent with a prompt to read first.
 */
export function RepoReadinessSection({
  conn,
  readiness,
  onOpenMiseTasks,
  onOpenInSessions,
  onFixed,
}: {
  conn: Connection;
  readiness: RepoReadiness;
  onOpenMiseTasks: () => void;
  onOpenInSessions: (selection: SessionSelection) => void;
  /** After a fix that changed the repo here (Format), so the readiness is asked again. */
  onFixed: () => void;
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
              onFixed={onFixed}
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
  onFixed,
}: {
  conn: Connection;
  repo: string;
  gap: ReadinessGap;
  onOpenMiseTasks: () => void;
  onOpenInSessions: (selection: SessionSelection) => void;
  onFixed: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const level = READINESS_GAP_LEVEL[gap.code];
  const fix = repoGapFix(gap.code);
  return (
    <li className="flex min-w-0 flex-col gap-2 px-3 py-2">
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2">
        <span className={cn("text-center font-mono text-sm", LEVEL_TONES[level])} aria-hidden="true">
          {LEVEL_MARKS[level]}
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
        {fix === "format" && <MiseFormatButton conn={conn} repos={[repo]} onDone={onFixed} />}
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
