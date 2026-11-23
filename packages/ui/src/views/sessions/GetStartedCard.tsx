import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { GetStartedStepList, GetStartedSummary } from "@/components/GetStartedSteps";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { doneStepsLine, type GetStartedPlan, type GetStartedStep, stepsLeft } from "@/lib/get-started";

/**
 * What is left before a first session, above the Sessions view's form (ADR-289): the steps of "Get started" (ADR-262)
 * from one run of the doctor, those not done one by one with what settles them right here (`action`: the projects
 * folder's form, "Trust folder"), the done ones in one line, and a link to Settings › Get started for every step and what
 * is good to have. It reads nothing itself, so the gallery of view states draws it too.
 */
export function GetStartedCard({
  plan,
  error,
  place,
  action,
  onCheckAgain,
  onOpenGetStarted,
}: {
  /** `undefined` while the doctor runs. */
  plan: GetStartedPlan | undefined;
  error: string | undefined;
  /** Where Trackwall runs (`getStartedPlace`). */
  place: string;
  action: (step: GetStartedStep) => ReactNode;
  onCheckAgain: () => void;
  onOpenGetStarted: () => void;
}) {
  const left = plan ? stepsLeft(plan) : [];
  const done = plan ? doneStepsLine(plan) : null;
  return (
    <div className="max-w-3xl px-6 pt-6">
      <Surface>
        <div className="divide-y">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            {plan ? (
              <GetStartedSummary plan={plan} place={place} />
            ) : (
              <Loading text="Checking what Trackwall needs before a first session…" />
            )}
            <Button variant="outline" size="sm" onClick={onCheckAgain}>
              Check again
            </Button>
          </div>
          {error && (
            <div className="px-4 py-3">
              <ErrorWithRetry message={error} onRetry={onCheckAgain} />
            </div>
          )}
          {done && (
            <p className="text-muted-foreground flex items-start gap-2 px-4 py-2 text-xs break-words">
              <Check className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
              {done}
            </p>
          )}
          {left.length > 0 && <GetStartedStepList steps={left} action={action} />}
          <p className="text-muted-foreground px-4 py-2 text-xs">
            Every step, and what is good to have:{" "}
            <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onOpenGetStarted}>
              Settings › Get started
            </button>
          </p>
        </div>
      </Surface>
    </div>
  );
}
