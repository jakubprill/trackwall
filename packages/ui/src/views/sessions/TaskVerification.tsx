import { type LogError, miseTaskLogSource, VERIFY_MISE_TASK, type Verification } from "@trackwall/protocol";
import { ScrollText, ShieldCheck, Square, Wrench } from "lucide-react";
import { useState } from "react";
import { MiseTaskLog } from "@/components/MiseTaskLog";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { useFailedTests } from "@/lib/use-failed-tests";
import type { TaskVerificationState } from "@/lib/use-task-verification";
import { testCountsLabel, verificationDuration, verificationLabel } from "@/lib/verification";
import { VerificationFailedTests } from "./VerificationFailedTests";

/** Lines of one log error in the section: the exception and its first frames; the whole error is in the log. */
const ERROR_LINES_SHOWN = 4;

/**
 * The verification of a task (ADR-64): the Verify button in the task panel's header runs the repo's mise task `test`
 * in the worktree, and the section below the summary shows the verdict, the test counts and the first failed tests
 * and log errors, the same result the agent gets from `verify_task`; the failed tests open to their stack trace and go
 * back to the agent with "Fix" (ADR-302).
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
      <VerificationDetails conn={conn} verification={verification} />
      {showLog && <MiseTaskLog conn={conn} source={miseTaskLogSource(verification.repo, verification.task, verification.miseTask)} />}
    </section>
  );
}

function VerificationDetails({ conn, verification }: { conn: Connection; verification: Verification }) {
  const { tests, message, failures, errors, lastLines } = verification;
  const actions = useFailedTests(conn, verification);
  const fixable = verification.state === "failed" && failures.length > 0;
  // The end of the output says why only when neither a test nor a log error does (e.g. mise could not start the task).
  const showLastLines = verification.state === "failed" && failures.length === 0 && errors.length === 0 && lastLines.length > 0;
  return (
    <>
      {verification.outdated && (
        <p className="text-xs">
          The worktree's files changed after this run started, so this verdict is about earlier changes. Verify again.
        </p>
      )}
      {(tests?.reports ?? 0) > 0 || fixable ? (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-sm">{tests && tests.reports > 0 && testCountsLabel(tests.totals)}</p>
          {fixable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions.fix(null)}
              disabled={actions.fixing}
              title="ask the task's agent to fix the failed tests below"
            >
              <Wrench /> Fix failed tests
            </Button>
          )}
        </div>
      ) : null}
      {actions.sent && <p className="text-muted-foreground text-xs">{actions.sent}</p>}
      {actions.error && <p className="text-destructive text-xs">{actions.error}</p>}
      {message && <p className="text-muted-foreground text-xs">{message}</p>}
      {failures.length > 0 && <VerificationFailedTests failures={failures} actions={actions} />}
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

function RunError({ error }: { error: LogError }) {
  return (
    <li>
      <pre className="text-destructive max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap">
        {error.lines.slice(0, ERROR_LINES_SHOWN).join("\n")}
      </pre>
    </li>
  );
}
