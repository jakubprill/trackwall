import { agentsApi, type Session, type Task } from "@trackwall/protocol";
import { Check, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { planStep } from "@/lib/task-plan";
import { useAction } from "@/lib/use-action";

const STEP_TEXT = {
  writing: "The agent is writing its plan in Plan mode; it changes no files until you approve the plan.",
  ready: "Read the plan in the conversation. Reply to change it, or approve it and the agent implements it.",
  resume: "Resume the task to read its plan and approve it.",
} as const;

/**
 * The strip of a task started with "Plan first" while its plan waits (ADR-227): what the agent does now, and "Approve
 * plan" once its turn ends, which switches it to Agent mode with the prompt to implement the plan.
 */
export function PlanApprovalNotice({
  conn,
  task,
  session,
  onApproved,
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  onApproved: () => void;
}) {
  const approve = useAction(() => post(conn, agentsApi.approvePlan, { task: task.id }), onApproved);
  const step = planStep(task, session);
  if (step === null) return null;
  return (
    <section aria-label="Plan first" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <ListChecks className="text-primary size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">Plan first</span>
      <span className="text-muted-foreground min-w-0">{STEP_TEXT[step]}</span>
      {approve.error && <span className="text-destructive min-w-0 truncate">{approve.error}</span>}
      {step === "ready" && (
        <Button variant="outline" size="sm" className="ml-auto" onClick={approve.run} disabled={approve.pending}>
          <Check /> Approve plan
        </Button>
      )}
    </section>
  );
}
