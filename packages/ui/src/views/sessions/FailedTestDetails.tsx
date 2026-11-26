import type { TestFailure } from "@trackwall/protocol";
import { Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { expectedActual, foldedTrace, type TraceLine, traceLines } from "@/lib/failed-test";
import type { TraceFrames } from "@/lib/use-failed-tests";
import { cn } from "@/lib/utils";

/**
 * A failed test opened in the task panel (ADR-302), in the Verification section and in the "Tests" tab (ADR-304): the
 * values its assertion compared, its stack trace with library frames folded and the frames of the test's own code as
 * links that open in VS Code, the report it comes from and "Fix this", which hands it to the task's agent.
 */
export function FailedTestDetails({
  failure,
  onFix,
  fixing,
  frames,
}: {
  failure: TestFailure;
  onFix: () => void;
  fixing: boolean;
  frames: TraceFrames;
}) {
  const compared = expectedActual(failure.message);
  return (
    <div className="flex min-w-0 flex-col gap-2">
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
      {failure.lines.length > 0 && <StackTrace failure={failure} frames={frames} />}
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={failure.report}>
          {failure.report}
        </span>
        <Button variant="outline" size="sm" onClick={onFix} disabled={fixing} title="ask the task's agent to fix this test">
          <Wrench /> Fix this
        </Button>
      </div>
    </div>
  );
}

/** The trace with library frames folded, until the user unfolds them; the lines the report left out are counted. */
function StackTrace({ failure, frames }: { failure: TestFailure; frames: TraceFrames }) {
  const [unfolded, setUnfolded] = useState(false);
  const lines = traceLines(failure);
  const rows = unfolded ? lines : foldedTrace(lines);
  return (
    <pre className="bg-muted max-h-48 overflow-auto rounded-sm border px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
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
          <TraceLineRow key={`${i}:${row.text}`} line={row} canOpen={frames.canOpen} onOpen={frames.openFrame} disabled={frames.opening} />
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
