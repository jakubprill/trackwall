import type { TestFailure } from "@trackwall/protocol";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { expectedActual, foldedTrace, type TraceLine, traceLines } from "@/lib/failed-test";
import type { FailedTestsActions } from "@/lib/use-failed-tests";
import { cn } from "@/lib/utils";
import { failedTestName } from "@/lib/verification";

/**
 * The failed tests of a verification in the task panel (ADR-64, ADR-302): one line each with its message, which opens to
 * the values its assertion compared and its stack trace, whose frames in the test's own code open in VS Code, and "Fix",
 * which hands the test to the task's agent.
 */
export function VerificationFailedTests({ failures, actions }: { failures: readonly TestFailure[]; actions: FailedTestsActions }) {
  const [opened, setOpened] = useState<number | null>(null);
  return (
    <ul aria-label="Failed tests" className="flex flex-col gap-1">
      {failures.map((failure, i) => (
        // Repeated test cases are kept on purpose (`test.each`, retries), so names alone are not unique.
        <FailedTest
          key={`${failure.report}:${failure.className}:${failure.name}:${i}`}
          failure={failure}
          open={opened === i}
          onToggle={() => setOpened(opened === i ? null : i)}
          onFix={() => actions.fix(i)}
          actions={actions}
        />
      ))}
    </ul>
  );
}

function FailedTest({
  failure,
  open,
  onToggle,
  onFix,
  actions,
}: {
  failure: TestFailure;
  open: boolean;
  onToggle: () => void;
  onFix: () => void;
  actions: FailedTestsActions;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={cn("flex flex-col gap-2 rounded-sm border px-2 py-1", open && "bg-card")}>
      <button type="button" className="flex min-w-0 items-center gap-2 text-left" aria-expanded={open} onClick={onToggle}>
        <Chevron className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="text-destructive shrink-0 font-mono text-xs">{failedTestName(failure)}</span>
        {failure.kind === "error" && <span className="text-destructive shrink-0 text-xs">error</span>}
        {!open && failure.message && <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{failure.message}</span>}
      </button>
      {open && <FailedTestDetails failure={failure} onFix={onFix} actions={actions} />}
    </li>
  );
}

function FailedTestDetails({ failure, onFix, actions }: { failure: TestFailure; onFix: () => void; actions: FailedTestsActions }) {
  const compared = expectedActual(failure.message);
  return (
    <div className="flex flex-col gap-2 pb-1">
      {compared ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs">
          <dt className="text-muted-foreground">expected</dt>
          <dd className="text-success break-all">{compared.expected}</dd>
          <dt className="text-muted-foreground">actual</dt>
          <dd className="text-destructive break-all">{compared.actual}</dd>
        </dl>
      ) : (
        failure.message && <p className="font-mono text-xs break-all whitespace-pre-wrap">{failure.message}</p>
      )}
      {failure.lines.length > 0 && <StackTrace failure={failure} actions={actions} />}
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={failure.report}>
          {failure.report}
        </span>
        <Button variant="outline" size="sm" onClick={onFix} disabled={actions.fixing} title="ask the task's agent to fix this test">
          <Wrench /> Fix this
        </Button>
      </div>
    </div>
  );
}

/** The trace with library frames folded, until the user unfolds them; the lines the report left out are counted. */
function StackTrace({ failure, actions }: { failure: TestFailure; actions: FailedTestsActions }) {
  const [unfolded, setUnfolded] = useState(false);
  const lines = traceLines(failure);
  const rows = unfolded ? lines : foldedTrace(lines);
  return (
    <pre className="bg-muted max-h-48 overflow-auto rounded-sm border px-2 py-1 font-mono text-xs whitespace-pre-wrap">
      {rows.map((row, i) =>
        row.kind === "folded" ? (
          <button
            // A trace repeats lines (recursion), so the place is part of the key.
            key={`${i}:folded`}
            type="button"
            className="text-muted-foreground block pl-6 text-left hover:underline"
            onClick={() => setUnfolded(true)}
          >
            {`… ${row.count} more library frames`}
          </button>
        ) : (
          <TraceLineRow
            key={`${i}:${row.text}`}
            line={row}
            canOpen={actions.canOpen}
            onOpen={actions.openFrame}
            disabled={actions.opening}
          />
        ),
      )}
      {failure.omittedLines > 0 && (
        <span className="text-muted-foreground block">{`… ${failure.omittedLines} more lines in the report`}</span>
      )}
    </pre>
  );
}

function TraceLineRow({
  line,
  canOpen,
  onOpen,
  disabled,
}: {
  line: TraceLine;
  canOpen: boolean;
  onOpen: (frame: string) => void;
  disabled: boolean;
}) {
  if (line.kind !== "own" || !canOpen)
    return <span className={cn("block", line.kind === "library" && "text-muted-foreground")}>{line.text}</span>;
  return (
    <button
      type="button"
      className="text-primary block text-left underline-offset-2 hover:underline disabled:opacity-50"
      onClick={() => onOpen(line.text)}
      disabled={disabled}
      title="open this line in VS Code"
    >
      {line.text}
    </button>
  );
}
