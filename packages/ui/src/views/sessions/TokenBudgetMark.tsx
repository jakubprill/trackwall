import type { SessionTokenBudget } from "@trackwall/protocol";
import { Gauge } from "lucide-react";
import { tokenBudgetLabel } from "@/lib/token-budget";

/** What the task's session used of its token budget since its start (ADR-237), next to its usage in the task's header. */
export function TokenBudgetMark({ budget }: { budget: SessionTokenBudget }) {
  const { label, title } = tokenBudgetLabel(budget);
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs" title={title}>
      <Gauge className="size-3" aria-hidden />
      {label}
    </span>
  );
}
