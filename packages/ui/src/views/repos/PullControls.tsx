import { ArrowDown, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { folderWorkWarning, pullLabel, type UpstreamOffer } from "@/lib/upstream-pull";
import type { PullHandle } from "@/lib/use-pull";
import { cn } from "@/lib/utils";

/**
 * The parts of a pull (ADR-269) that the Upstream tile and a row of All repos (ADR-291) show alike: the button, the
 * question asked first when something works in the repo folder, and a failure with its retry.
 */

/**
 * "Pull 15", and "Pulling…" while it runs; the tooltip says which branch moves where. Outlined among the rows of All
 * repos, where several stand one under another.
 */
export function PullButton({
  offer,
  pull,
  variant,
  className,
}: {
  offer: Extract<UpstreamOffer, { kind: "pull" }>;
  pull: PullHandle;
  variant?: "outline";
  className?: string;
}) {
  const running = pull.state.kind === "running";
  return (
    <Button variant={variant} size="sm" className={cn("h-7", className)} disabled={running} onClick={pull.start} title={offer.title}>
      {running ? <RotateCw className="animate-spin" /> : <ArrowDown />}
      {running ? "Pulling…" : pullLabel(offer.behind)}
    </Button>
  );
}

export function PullQuestion({ workInFolder, pull }: { workInFolder: readonly string[]; pull: PullHandle }) {
  return (
    <span className="flex flex-col gap-1 text-xs">
      <span className="text-warning">{folderWorkWarning(workInFolder)}</span>
      <span className="flex gap-2">
        <Button size="sm" className="h-7" onClick={pull.run}>
          Pull anyway
        </Button>
        <Button variant="outline" size="sm" className="h-7" onClick={pull.reset}>
          Cancel
        </Button>
      </span>
    </span>
  );
}

export function PullFailure({ message, pull }: { message: string; pull: PullHandle }) {
  return (
    <span className="flex flex-col items-start gap-1 text-xs">
      <span className="text-destructive whitespace-pre-wrap break-words">Pull failed: {message}</span>
      <Button variant="outline" size="sm" className="h-7" onClick={pull.run}>
        <RotateCw /> Retry
      </Button>
    </span>
  );
}
