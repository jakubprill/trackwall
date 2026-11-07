import { STACK_TRACE_MAX } from "@trackwall/protocol";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The stack trace of a new task (ADR-222), folded until the user opens it: most tasks have none. The daemon finds its
 * frames among the repo's files and asks the agent to reproduce the error in a failing test before it fixes it.
 */
export function StackTraceField({
  shown,
  value,
  open,
  disabled,
  onChange,
  onOpen,
}: {
  /** Only a task in its own worktree has one (`offersStackTrace`); what was pasted stays while the form shows something else. */
  shown: boolean;
  value: string;
  open: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onOpen: (open: boolean) => void;
}) {
  if (!shown) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button variant="ghost" size="sm" className="w-fit" aria-expanded={open} onClick={() => onOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />} Stack trace
      </Button>
      {open && (
        <>
          <Textarea
            aria-label="Stack trace"
            placeholder={"Paste a Java stack trace, e.g.\njava.lang.NullPointerException\n\tat com.example.shop.Order.total(Order.java:42)"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            maxLength={STACK_TRACE_MAX}
            rows={8}
            className="font-mono text-xs"
            disabled={disabled}
          />
          <p className="text-muted-foreground max-w-prose text-xs">
            The agent gets the trace with its frames found among the repo's files, and writes a test that fails the same way before it fixes
            the code.
          </p>
        </>
      )}
    </div>
  );
}
