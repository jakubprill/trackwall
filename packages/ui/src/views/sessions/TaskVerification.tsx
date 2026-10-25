import { type LogError, miseTaskLogSource, type TestFailure, VERIFY_MISE_TASK, type Verification } from "@trackwall/protocol";
import { ScrollText, ShieldCheck, Square } from "lucide-react";
import { useState } from "react";
import { MiseTaskLog } from "@/components/MiseTaskLog";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import type { TaskVerificationState } from "@/lib/use-task-verification";
import { failedTestName, testCountsLabel, verificationDuration, verificationLabel } from "@/lib/verification";

/** Lines of one log error in the section: the exception and its first frames; the whole error is in the log. */
const ERROR_LINES_SHOWN = 4;

/**
 * The verification of a task (ADR-64): the Verify button in the task panel's header runs the repo's mise task `test`
 * in the worktree, and the section below the summary shows the verdict, the test counts and the first failed tests
 * and log errors, the same result the agent gets from `verify_task`.
 */

export function VerifyButton({ state, disabled }: { state: TaskVerificationState; disabled: boolean }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={state.start}
      disabled={disabled || state.starting || state.running}
      title={`run mise task ${VERIFY_MISE_TASK} in the worktree and sum up the result`}
    >
      <ShieldCheck /> {state.running ? "Verifying…" : "Verify"}
    </Button>
  );
}

export function TaskVerification({ conn, state }: { conn: Connection; state: TaskVerificationState }) {
  const [showLog, setShowLog] = useState(false);
  const { verification } = state;
  if (!verification) return state.error ? <p className="text-destructive border-b px-4 py-2 text-xs">{state.error}</p> : null;
  const duration = verificationDuration(verification);
  return (
    <section aria-label="Verification" className="flex flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">Verification</span>
        <StatusLabel {...verificationLabel(verification)} />
        <span className="text-muted-foreground flex-1 truncate text-xs">
          {`mise task ${verification.miseTask} · started ${relativeTime(verification.startedAt, new Date())}`}
          {duration && ` · took ${duration}`}
        </span>
        {state.error && <span className="text-destructive max-w-xs truncate text-xs">{state.error}</span>}
        <Button variant="ghost" size="sm" onClick={() => setShowLog((shown) => !shown)} aria-pressed={showLog}>
          <ScrollText /> Log
        </Button>
        {state.running && (
          <Button variant="outline" size="sm" onClick={state.cancel} disabled={state.cancelling}>
            <Square /> Cancel
          </Button>
        )}
      </div>
      <VerificationDetails verification={verification} />
      {showLog && <MiseTaskLog conn={conn} source={miseTaskLogSource(verification.repo, verification.task, verification.miseTask)} />}
    </section>
  );
}

function VerificationDetails({ verification }: { verification: Verification }) {
  const { tests, message, failures, errors, lastLines } = verification;
  // The end of the output says why only when neither a test nor a log error does (e.g. mise could not start the task).
  const showLastLines = verification.state === "failed" && failures.length === 0 && errors.length === 0 && lastLines.length > 0;
  return (
    <>
      {tests && tests.reports > 0 && <p className="text-sm">{testCountsLabel(tests.totals)}</p>}
      {message && <p className="text-muted-foreground text-xs">{message}</p>}
      {failures.length > 0 && (
        <ul aria-label="Failed tests" className="flex flex-col gap-1">
          {failures.map((failure, i) => (
            // Repeated test cases are kept on purpose (`test.each`, retries), so names alone are not unique.
            <FailedTest key={`${failure.report}:${failure.className}:${failure.name}:${i}`} failure={failure} />
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <ul aria-label="Errors from the log" className="flex flex-col gap-1">
          {errors.map((error) => (
            <RunError key={error.seq} error={error} />
          ))}
        </ul>
      )}
      {showLastLines && <pre className="text-muted-foreground max-h-32 overflow-auto font-mono text-xs">{lastLines.join("\n")}</pre>}
    </>
  );
}

function FailedTest({ failure }: { failure: TestFailure }) {
  return (
    <li className="flex flex-col">
      <span className="text-destructive font-mono text-xs">{failedTestName(failure)}</span>
      {failure.message && <span className="text-muted-foreground line-clamp-2 font-mono text-xs">{failure.message}</span>}
    </li>
  );
}

function RunError({ error }: { error: LogError }) {
  return (
    <li>
      <pre className="text-destructive max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap">
        {error.lines.slice(0, ERROR_LINES_SHOWN).join("\n")}
      </pre>
    </li>
  );
}
