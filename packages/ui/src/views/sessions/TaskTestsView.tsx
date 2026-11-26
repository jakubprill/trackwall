import type { TaskTestCase, TaskTests } from "@trackwall/protocol";
import { countLabel } from "@trackwall/protocol";
import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import {
  failedCount,
  filterCount,
  groupCountLabel,
  isFailed,
  startsOpen,
  TESTS_FILTERS,
  type TestGroup,
  type TestsFilter,
  testGroups,
  testKeys,
  testTime,
} from "@/lib/task-tests";
import { type TraceFrames, useTraceFrames } from "@/lib/use-failed-tests";
import type { TaskTestsState } from "@/lib/use-task-tests";
import type { TaskVerificationState } from "@/lib/use-task-verification";
import { cn } from "@/lib/utils";
import { shortClassName, testCountsLabel } from "@/lib/verification";
import { FailedTestDetails } from "./FailedTestDetails.tsx";

/**
 * The "Tests" tab of a task (ADR-304): the tests of the JUnit reports in its worktree, from Verify and from the agent's
 * own runs, by default only the failed ones, on request the skipped or all of them, by class and narrowed by a name,
 * without pages. The selected test opens on the right as in the Verification section, with "Fix this".
 */
export function TaskTestsView({
  conn,
  task,
  state,
  verification,
  paused,
}: {
  conn: Connection;
  task: string;
  state: TaskTestsState;
  /** Verify here is the header's Verify, which writes new reports. */
  verification: TaskVerificationState;
  /** The task is being ended. */
  paused: boolean;
}) {
  const frames = useTraceFrames(conn, task);
  const onVerify = verification.start;
  const verifying = paused || verification.starting || verification.running;
  const { tests } = state;
  if (!tests) return <p className="text-muted-foreground p-4 text-sm">{state.error ?? "Reading the test reports…"}</p>;
  return (
    <section aria-label="Test reports" className="flex min-h-0 flex-1 flex-col">
      {tests.changedAfter && <OutdatedNote onVerify={onVerify} verifying={verifying} />}
      <TestsBar tests={tests} state={state} />
      {tests.reports === 0 ? (
        <NoReports onVerify={onVerify} verifying={verifying} />
      ) : (
        <TestsList tests={tests} state={state} frames={frames} />
      )}
    </section>
  );
}

function OutdatedNote({ onVerify, verifying }: { onVerify: () => void; verifying: boolean }) {
  return (
    <p role="status" className="text-warning bg-warning/10 flex items-center gap-3 border-b px-4 py-2 text-xs">
      <span className="flex-1">Files changed after these reports were written, so some results may be out of date.</span>
      <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying}>
        <ShieldCheck /> Verify again
      </Button>
    </p>
  );
}

function TestsBar({ tests, state }: { tests: TaskTests; state: TaskTestsState }) {
  const failed = failedCount(tests);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm">
      {tests.reports === 0 ? (
        <span className="text-muted-foreground">No test reports</span>
      ) : (
        <>
          <span className={cn(failed > 0 && "text-destructive")}>{testCountsLabel(tests.totals)}</span>
          {tests.newestReportAt && (
            <span className="text-muted-foreground text-xs">
              {`reports from ${relativeTime(tests.newestReportAt, new Date())} · ${countLabel(tests.reports, { one: "file", other: "files" })}`}
            </span>
          )}
        </>
      )}
      {tests.problems.length > 0 && (
        <span className="text-warning text-xs" title={tests.problems.map((p) => `${p.path}: ${p.message}`).join("\n")}>
          {`${countLabel(tests.problems.length, { one: "report", other: "reports" })} could not be read`}
        </span>
      )}
      <span className="flex-1" />
      <Button variant="outline" size="sm" onClick={state.reload} title="read the test reports in the worktree again">
        <RefreshCw /> Refresh
      </Button>
      {failed > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => state.fix(null)}
          disabled={state.fixing}
          title="ask the task's agent to fix the failed tests"
        >
          <Wrench /> Fix failed tests
        </Button>
      )}
      {/* On a line of its own, so a long note does not push the buttons onto another row. */}
      {(state.sent ?? state.error) && (
        <p className={cn("basis-full text-xs", state.error ? "text-destructive" : "text-muted-foreground")}>{state.error ?? state.sent}</p>
      )}
    </div>
  );
}

function NoReports({ onVerify, verifying }: { onVerify: () => void; verifying: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm">No test reports in this worktree yet</p>
      <p className="text-muted-foreground max-w-prose text-xs">
        Run the tests with Verify, or let the agent run them. Maven, Gradle, Vitest and other tools that write JUnit XML reports show up
        here.
      </p>
      <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying}>
        <ShieldCheck /> Verify
      </Button>
    </div>
  );
}

/** The filters and the list on the left, the selected test on the right. */
function TestsList({ tests, state, frames }: { tests: TaskTests; state: TaskTestsState; frames: TraceFrames }) {
  const [filter, setFilter] = useState<TestsFilter>("failed");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const keys = testKeys(tests.cases);
  const groups = testGroups(tests.cases, filter, query);
  const shownCases = groups.flatMap((g) => g.cases);
  const current = shownCases.find((c) => keys.get(c) === selected) ?? shownCases[0];
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-5">
      <div className="flex min-h-0 flex-col border-b md:col-span-2 md:border-r md:border-b-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {TESTS_FILTERS.map((f) => (
            <Button
              key={f.id}
              variant={filter === f.id ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {`${f.label} ${filterCount(tests, f.id)}`}
            </Button>
          ))}
          <Input
            aria-label="Filter tests by name"
            placeholder="Filter by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 min-w-32 flex-1"
          />
        </div>
        {/* Keyed by the filter, so every class starts folded or open as the filter wants it. */}
        <TestGroups key={filter} groups={groups} filter={filter} keys={keys} current={current} onSelect={setSelected} />
      </div>
      <div className="min-h-0 overflow-y-auto p-4 md:col-span-3">
        {current ? (
          <SelectedTest test={current} tests={tests} state={state} frames={frames} />
        ) : (
          <EmptyList tests={tests} filter={filter} onShowAll={() => setFilter("all")} />
        )}
      </div>
    </div>
  );
}

function TestGroups({
  groups,
  filter,
  keys,
  current,
  onSelect,
}: {
  groups: readonly TestGroup[];
  filter: TestsFilter;
  keys: ReadonlyMap<TaskTestCase, string>;
  current: TaskTestCase | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  return (
    <ul aria-label="Tests" className="min-h-0 flex-1 overflow-y-auto py-1">
      {groups.map((group) => {
        const open = startsOpen(group, filter) !== toggled.has(group.name);
        const Chevron = open ? ChevronDown : ChevronRight;
        return (
          <li key={group.name}>
            <button
              type="button"
              aria-expanded={open}
              className="hover:bg-accent flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left"
              onClick={() => setToggled(withToggled(toggled, group.name))}
              title={group.name}
            >
              <Chevron className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <OutcomeDot failed={group.failed > 0} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{shortClassName(group.name)}</span>
              <span className="text-muted-foreground shrink-0 font-mono text-xs">{groupCountLabel(group)}</span>
            </button>
            {open && (
              <ul>
                {group.cases.map((c) => (
                  <TestRow key={keys.get(c)} test={c} selected={c === current} onSelect={() => onSelect(keys.get(c))} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function withToggled(set: ReadonlySet<string>, name: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(name)) next.add(name);
  return next;
}

function TestRow({ test, selected, onSelect }: { test: TaskTestCase; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        className={cn("hover:bg-accent flex w-full min-w-0 items-center gap-2 py-1 pr-3 pl-9 text-left", selected && "bg-accent")}
        onClick={onSelect}
        title={test.name}
      >
        <OutcomeDot failed={isFailed(test)} skipped={test.kind === "skipped"} />
        <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", test.kind === "skipped" && "text-muted-foreground")}>
          {test.name}
        </span>
        {test.kind === "error" && <span className="text-destructive shrink-0 text-xs">error</span>}
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {test.kind === "skipped" ? "skipped" : testTime(test.timeSeconds)}
        </span>
      </button>
    </li>
  );
}

function OutcomeDot({ failed, skipped = false }: { failed: boolean; skipped?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", failed ? "bg-destructive" : skipped ? "bg-muted-foreground" : "bg-success")}
    />
  );
}

function SelectedTest({
  test,
  tests,
  state,
  frames,
}: {
  test: TaskTestCase;
  tests: TaskTests;
  state: TaskTestsState;
  frames: TraceFrames;
}) {
  const failure = test.failure === null ? undefined : tests.failures[test.failure];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "min-w-0 truncate font-mono text-sm",
            isFailed(test) ? "text-destructive" : test.kind === "passed" && "text-success",
          )}
        >
          {test.name}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {[test.kind, testTime(test.timeSeconds)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <p className="text-muted-foreground font-mono text-xs break-all">{`${test.className ?? test.suite} · ${test.report}`}</p>
      {failure ? (
        <FailedTestDetails
          failure={failure}
          onFix={() => state.fix({ report: test.report, className: test.className, name: test.name })}
          fixing={state.fixing}
          frames={frames}
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          {isFailed(test)
            ? "This failed test is past the ones Trackwall reads in detail: open its report."
            : "A test that did not fail has nothing more to show."}
        </p>
      )}
    </div>
  );
}

/** Nothing on the list: every test passed, or the filter or the name let none through. */
function EmptyList({ tests, filter, onShowAll }: { tests: TaskTests; filter: TestsFilter; onShowAll: () => void }) {
  if (filter === "failed" && failedCount(tests) === 0)
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-success text-sm">✓ No test failed</p>
        <p className="text-muted-foreground text-xs">{`All ${countLabel(tests.totals.tests - tests.totals.skipped, { one: "test", other: "tests" })} that ran passed.`}</p>
        <Button variant="outline" size="sm" onClick={onShowAll}>
          {`Show all ${tests.totals.tests}`}
        </Button>
      </div>
    );
  return <p className="text-muted-foreground text-sm">No test matches.</p>;
}
