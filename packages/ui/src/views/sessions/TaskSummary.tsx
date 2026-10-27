import type { Task } from "@trackwall/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The summary from the task session (`report_result`, ADR-39) with the time it was reported. It spans the panel's
 * width and shows two lines until opened, because a summary of a few paragraphs above the terminal would leave the
 * terminal a few lines in the one-entry layout. "Show all" appears only when the two lines cut the text.
 */
export function TaskSummary({ summary }: { summary: NonNullable<Task["summary"]> }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
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
      <p ref={text} className={cn("min-w-0 flex-1 text-sm whitespace-pre-wrap", !open && "line-clamp-2")}>
        {summary.text}
      </p>
      {(cut || open) && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </section>
  );
}
