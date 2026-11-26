import type { TestFailure } from "@trackwall/protocol";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { FailedTestsActions } from "@/lib/use-failed-tests";
import { cn } from "@/lib/utils";
import { failedTestName } from "@/lib/verification";
import { FailedTestDetails } from "./FailedTestDetails.tsx";

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
      {open && (
        <div className="pb-1">
          <FailedTestDetails failure={failure} onFix={onFix} fixing={actions.fixing} frames={actions} />
        </div>
      )}
    </li>
  );
}
