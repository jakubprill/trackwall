import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { CopyableCode } from "@/components/CopyableCode";
import { Surface } from "@/components/Surface";
import { fixCommand, type GetStartedPlan, type GetStartedStep, type GoodToHave, goodToHaveSummary } from "@/lib/get-started";
import { cn } from "@/lib/utils";

/**
 * The steps of "Get started" (ADR-262) for a plan: each with its state, what was found and what to do, and the tools
 * that are good to have folded under them. It reads nothing itself, so the gallery of view states draws it too; the
 * form of an open step (the projects folder) comes from `action`.
 */
export function GetStartedSteps({ plan, action }: { plan: GetStartedPlan; action?: (step: GetStartedStep) => ReactNode }) {
  return (
    <>
      <Surface>
        <ol>
          {plan.steps.map((step, i) => (
            <Step key={step.id} step={step} number={i + 1}>
              {action?.(step)}
            </Step>
          ))}
        </ol>
      </Surface>
      {plan.goodToHave.length > 0 && (
        <Surface>
          <details className="group">
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">Good to have</span>
              <span className="text-muted-foreground min-w-0 text-xs break-words">{goodToHaveSummary(plan.goodToHave)}</span>
            </summary>
            <ul className="border-t">
              {plan.goodToHave.map((item) => (
                <GoodToHaveEntry key={item.id} item={item} />
              ))}
            </ul>
          </details>
        </Surface>
      )}
    </>
  );
}

function Step({ step, number, children }: { step: GetStartedStep; number: number; children?: ReactNode }) {
  const command = fixCommand(step.fix);
  return (
    <li className="flex gap-3 border-b px-4 py-3 last:border-b-0">
      <StepMark state={step.state} number={number} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-sm font-medium">{step.title}</span>
          {step.state === "todo" && <span className="text-muted-foreground text-xs">{step.need}</span>}
        </div>
        <span className="text-muted-foreground text-xs break-words">{step.summary}</span>
        {/* A step settled right here shows its form instead of the sentence that sends the user elsewhere. */}
        {children ? (
          <div className="flex flex-col gap-2 pt-1">{children}</div>
        ) : (
          <>
            {step.fix && <span className="text-xs break-words">{step.fix}</span>}
            {command && <CopyableCode text={command} />}
          </>
        )}
      </div>
    </li>
  );
}

function StepMark({ state, number }: { state: GetStartedStep["state"]; number: number }) {
  return (
    <span
      role="img"
      aria-label={state === "done" ? "Done" : state === "todo" ? "To do" : "Later"}
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-xs [&_svg]:size-3",
        state === "done" && "bg-success/20 text-success",
        state === "todo" && "bg-warning/20 text-warning",
        state === "later" && "text-muted-foreground border",
      )}
    >
      {state === "done" ? <Check /> : number}
    </span>
  );
}

function GoodToHaveEntry({ item }: { item: GoodToHave }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 border-b px-4 py-3 last:border-b-0">
      <span className="flex items-baseline gap-2 text-sm">
        <span className={cn("text-xs font-medium", item.ok ? "text-success" : "text-muted-foreground")}>{item.ok ? "OK" : "Not yet"}</span>
        <span className="font-medium">{item.title}</span>
      </span>
      <span className="text-muted-foreground text-xs break-words">{item.summary}</span>
      {!item.ok && item.fix && <span className="text-xs break-words">{item.fix}</span>}
    </li>
  );
}
