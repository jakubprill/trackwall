import type { ReproTest, Task } from "@trackwall/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { summaryToggleLabel } from "@/lib/task-summary";
import { cn } from "@/lib/utils";
import { ReproductionCheck } from "./ReproductionCheck.tsx";

/**
 * The summary from the task session (`report_result`, ADR-39) with the time it was reported. It spans the panel's
 * width and shows two lines until opened, because a summary of a few paragraphs above the terminal would leave the
 * terminal a few lines in the one-entry layout. "Show all" appears only when the two lines cut the text. The check
 * steps (ADR-169) show only when opened: they are a hint the user asks for, not something the panel puts in their way.
 * The test the agent says reproduces the task's error (ADR-222) is always in sight, worded as the agent's claim, with
 * Trackwall's own check of it under it (ADR-227).
 */
export function TaskSummary({ conn, task, summary }: { conn: Connection; task: string; summary: NonNullable<Task["summary"]> }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const steps = summary.checkSteps.length;
  const toggle = summaryToggleLabel(open, cut, steps);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || open) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, summary.text]);
  return (
    <section aria-label="Summary from the task session" className="flex items-start gap-3 border-b px-4 py-2">
      <span className="hud-label flex shrink-0 flex-col pt-0.5">
        Summary <span className="text-muted-foreground font-sans normal-case">{relativeTime(summary.reportedAt, new Date())}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p ref={text} className={cn("text-sm whitespace-pre-wrap", !open && "line-clamp-2")}>
          {summary.text}
        </p>
        {summary.reproTest && (
          <>
            <ReproTestClaim test={summary.reproTest} />
            <ReproductionCheck conn={conn} task={task} test={summary.reproTest} />
          </>
        )}
        {open && steps > 0 && (
          <section aria-label="How to check" className="mt-2">
            <span className="hud-label">How to check</span>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
              {summary.checkSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
        )}
      </div>
      {toggle && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setOpen(!open)} aria-expanded={open}>
          {toggle}
        </Button>
      )}
    </section>
  );
}

/** The agent's reproduction test (ADR-222): what it says; Trackwall's check of it is below it. */
function ReproTestClaim({ test }: { test: ReproTest }) {
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      <span className="text-foreground">Reproduction test</span> (the agent's word):{" "}
      <span className="text-foreground font-mono">{test.name}</span> in <span className="font-mono">{test.file}</span>, failed before the
      fix with: {test.failure}
    </p>
  );
}
