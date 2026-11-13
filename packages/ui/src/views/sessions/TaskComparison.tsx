import { agentsApi, autoReviewApi, otherAttempts, type Session, type Task, type TaskOutcome } from "@trackwall/protocol";
import { Crown, ExternalLink } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { SessionStateLabel } from "@/components/SessionStateLabel";
import { TaskOutcomeMarks } from "@/components/TaskOutcomeMarks";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { usageDetails, usageLabel } from "@/lib/copilot-usage";
import { DIFF_LINE_CLASSES, DIFF_SHOWN_LINES, diffLines, fileDiffs } from "@/lib/diff-lines";
import { latestSession } from "@/lib/session-entries";
import { isLive } from "@/lib/session-state";
import {
  attemptModel,
  type ComparedFile,
  changeTotals,
  comparedAttempt,
  comparedFiles,
  fileChangeLabel,
  reviewLabel,
} from "@/lib/task-comparison";
import { outcomeMarks } from "@/lib/task-outcomes";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { StopButton } from "./TaskButtons.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";

/** The two diffs are re-read this often while the tab is open: the agents may still be at work. */
const POLL_MS = 5000;

/** The user's pick of the attempt to keep, and so of the one to end. */
interface Keeping {
  keep: Task;
  end: Task;
}

/**
 * The "Compare" tab of a task with another attempt at it (ADR-251): the task and that attempt in two columns (model,
 * state, what it used, its verdict and review, its changes and report), the files either of them changed with what
 * each did, a file's two diffs side by side, and "Keep this one", which ends the other attempt and tells the task
 * journal which one the user kept.
 */
export function TaskComparison({
  conn,
  task,
  tasks,
  sessions,
  outcomes,
  paused,
  onChanged,
  onOpenTask,
  onRemoved,
}: {
  conn: Connection;
  task: Task;
  tasks: readonly Task[];
  sessions: readonly Session[];
  outcomes: ReadonlyMap<string, TaskOutcome>;
  paused: boolean;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
  /** This panel's task was ended, so the panel goes. */
  onRemoved: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const other = comparedAttempt(task, tasks, picked);
  if (other === undefined) return <p className="text-muted-foreground text-sm">No other attempt at this task is left to compare.</p>;
  const others = otherAttempts(task, tasks);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground max-w-prose text-xs">
        Both attempts start from the same prompt and commit, so what differs is their work. Keep the better one: the other one ends, and the
        task journal remembers which model you kept.
      </p>
      {others.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          Compare with
          <select
            aria-label="Attempt to compare with"
            value={other.id}
            onChange={(e) => setPicked(e.target.value)}
            className="border-input bg-card h-8 rounded-md border px-2 text-sm"
          >
            {others.map((t) => (
              <option key={t.id} value={t.id}>
                {attemptModel(t, undefined).asked} · {t.branch}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Keyed by the other attempt, so a pick starts with no file open and no end pending. */}
      <Comparison
        key={other.id}
        conn={conn}
        task={task}
        other={other}
        sessions={sessions}
        outcomes={outcomes}
        paused={paused}
        onChanged={onChanged}
        onOpenTask={onOpenTask}
        onRemoved={onRemoved}
      />
    </div>
  );
}

/** The panel's task and one other attempt at it, their files, and keeping one of them. */
function Comparison({
  conn,
  task,
  other,
  sessions,
  outcomes,
  paused,
  onChanged,
  onOpenTask,
  onRemoved,
}: {
  conn: Connection;
  task: Task;
  other: Task;
  sessions: readonly Session[];
  outcomes: ReadonlyMap<string, TaskOutcome>;
  paused: boolean;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
  onRemoved: () => void;
}) {
  const [keeping, setKeeping] = useState<Keeping | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const stopped = paused || keeping !== null;
  const left = useAttempt(conn, task.id, stopped);
  const right = useAttempt(conn, other.id, stopped);
  const files = comparedFiles(left.changes?.files ?? [], right.changes?.files ?? []);
  const ended = (kept: Keeping) => {
    setKeeping(null);
    if (kept.end.id === task.id) {
      onRemoved();
      onOpenTask(kept.keep.id);
    } else onChanged();
  };
  const columns = [
    { heading: "This task", attempt: task, rival: other, data: left, onOpen: undefined },
    { heading: "Other attempt", attempt: other, rival: task, data: right, onOpen: () => onOpenTask(other.id) },
  ];

  return (
    <>
      {keeping && (
        <KeepConfirmation
          conn={conn}
          keeping={keeping}
          session={latestSession(sessions, keeping.end.id)}
          onEnded={() => ended(keeping)}
          onStopped={onChanged}
          onCancel={() => setKeeping(null)}
        />
      )}
      <div className="grid grid-cols-2 gap-4">
        {columns.map(({ heading, attempt, rival, data, onOpen }) => (
          <AttemptColumn
            key={attempt.id}
            heading={heading}
            task={attempt}
            session={latestSession(sessions, attempt.id)}
            outcome={outcomes.get(attempt.id)}
            data={data}
            onOpen={onOpen}
            onKeep={keeping === null ? () => setKeeping({ keep: attempt, end: rival }) : undefined}
          />
        ))}
      </div>
      <FileList files={files} open={file} onOpen={(path) => setFile(path === file ? null : path)} />
      {file !== null && <SideBySide path={file} left={left.changes?.patch ?? ""} right={right.changes?.patch ?? ""} />}
    </>
  );
}

/** One attempt's changes and its last automatic code review (ADR-182), read again while the tab is open. */
function useAttempt(conn: Connection, task: string, paused: boolean) {
  const loadChanges = useCallback(() => post(conn, agentsApi.taskChanges, { task }), [conn, task]);
  const loadReview = useCallback(() => post(conn, autoReviewApi.get, { task, kind: "code" }), [conn, task]);
  const changes = useRemote(paused ? undefined : loadChanges, { pollMs: POLL_MS });
  const review = useRemote(paused ? undefined : loadReview, { pollMs: POLL_MS });
  return { changes: changes.data, review: review.data, error: changes.error ?? review.error };
}

type AttemptData = ReturnType<typeof useAttempt>;

function AttemptColumn({
  heading,
  task,
  session,
  outcome,
  data,
  onOpen,
  onKeep,
}: {
  heading: string;
  task: Task;
  session: Session | undefined;
  outcome: TaskOutcome | undefined;
  data: AttemptData;
  onOpen: (() => void) | undefined;
  onKeep: (() => void) | undefined;
}) {
  const model = attemptModel(task, session);
  const marks = outcomeMarks(outcome, task.inReview);
  const usage = session?.usage ?? null;
  return (
    <section aria-label={`${heading}: ${model.asked}`} className="bg-card flex min-w-0 flex-col gap-3 rounded-md border p-3">
      <header className="flex min-w-0 flex-col gap-0.5">
        <span className="hud-label">{heading}</span>
        <span className="truncate font-mono text-sm font-medium">{model.asked}</span>
        {model.runsOn !== null && <span className="text-warning text-xs">runs on {model.runsOn}</span>}
        <span className="text-muted-foreground truncate font-mono text-xs">{task.branch}</span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <Fact label="State">{session ? <SessionStateLabel session={session} /> : "no session"}</Fact>
        <Fact label="Used">
          {usage ? (
            <span className="font-mono" title={usageDetails(usage)}>
              {usageLabel(usage)}
            </span>
          ) : (
            "–"
          )}
        </Fact>
        <Fact label="Outcome">{marks.length > 0 ? <TaskOutcomeMarks marks={marks} /> : "not verified"}</Fact>
        <Fact label="Review">{data.review === undefined ? "…" : reviewLabel(data.review)}</Fact>
        <Fact label="Changes">
          {data.changes === undefined ? "…" : `${changeTotals(data.changes.files)} · uncommitted: ${data.changes.uncommitted}`}
        </Fact>
      </dl>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="hud-label">Agent's report</span>
        <p className="text-muted-foreground line-clamp-6 text-xs break-words whitespace-pre-wrap">
          {task.summary?.text ?? "No report yet."}
        </p>
      </div>
      {data.error && <p className="text-destructive text-xs break-words">{data.error}</p>}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onKeep} disabled={onKeep === undefined}>
          <Crown /> Keep this one
        </Button>
        {onOpen && (
          <Button variant="ghost" size="sm" onClick={onOpen}>
            <ExternalLink /> Open
          </Button>
        )}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * Ending the attempt the user did not keep: its session must stop first, as for any end of a task, and then
 * `TaskRemoval` asks about its branch and names the kept attempt.
 */
function KeepConfirmation({
  conn,
  keeping,
  session,
  onEnded,
  onStopped,
  onCancel,
}: {
  conn: Connection;
  keeping: Keeping;
  session: Session | undefined;
  onEnded: () => void;
  onStopped: () => void;
  onCancel: () => void;
}) {
  if (session && isLive(session))
    return (
      <div
        role="alertdialog"
        aria-label="End the other attempt"
        className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-3"
      >
        <p className="text-sm">
          The attempt to end, <span className="font-mono">{keeping.end.branch}</span>, still runs. Stop it first.
        </p>
        <StopButton conn={conn} session={session} onStopped={onStopped} />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="rounded-md border">
      <TaskRemoval conn={conn} task={keeping.end} keptInstead={keeping.keep} onRemoved={onEnded} onCancel={onCancel} />
    </div>
  );
}

/** Every file either attempt changed, with what each did to it; a click shows the file's two diffs side by side. */
function FileList({ files, open, onOpen }: { files: readonly ComparedFile[]; open: string | null; onOpen: (path: string) => void }) {
  if (files.length === 0) return <p className="text-muted-foreground text-sm">Neither attempt has changed anything yet.</p>;
  return (
    <section aria-label="Changed files" className="overflow-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-card">
          <tr className="border-b">
            {["File", "This task", "Other attempt"].map((h) => (
              <th key={h} scope="col" className="hud-label px-2 py-1.5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path} className={cn("border-b last:border-b-0", f.path === open && "bg-accent")}>
              <td className="px-2 py-1">
                <button
                  type="button"
                  className="hover:text-primary truncate text-left font-mono"
                  aria-expanded={f.path === open}
                  onClick={() => onOpen(f.path)}
                >
                  {f.path}
                </button>
              </td>
              <td className="text-muted-foreground px-2 py-1 font-mono whitespace-nowrap">{fileChangeLabel(f.left)}</td>
              <td className="text-muted-foreground px-2 py-1 font-mono whitespace-nowrap">{fileChangeLabel(f.right)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One file's diff in each attempt, next to each other. */
function SideBySide({ path, left, right }: { path: string; left: string; right: string }) {
  return (
    <section aria-label={`Both diffs of ${path}`} className="grid grid-cols-2 gap-4">
      <FileDiff label="This task" part={fileDiffs(left).get(path)} />
      <FileDiff label="Other attempt" part={fileDiffs(right).get(path)} />
    </section>
  );
}

function FileDiff({ label, part }: { label: string; part: string | undefined }) {
  const { lines, more } = diffLines(part ?? "", DIFF_SHOWN_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="hud-label">{label}</span>
      {part === undefined ? (
        <p className="text-muted-foreground text-xs">Left this file alone, or its diff is past the part Trackwall reads.</p>
      ) : (
        <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-5">
          {lines.map((line) => (
            <div key={line.offset} className={cn("px-1 whitespace-pre", DIFF_LINE_CLASSES[line.kind])}>
              {line.text || " "}
            </div>
          ))}
        </pre>
      )}
      {more && <p className="text-muted-foreground text-xs">The diff is longer; showing the beginning.</p>}
    </div>
  );
}
