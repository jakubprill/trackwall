import type { CopilotUsage } from "@trackwall/protocol";
import { Coins } from "lucide-react";
import { usageDetails, usageLabel, usageShortLabel } from "@/lib/copilot-usage";

/**
 * What a conversation used (ADR-190), as a quiet mark with its details on hover; nothing before the first model call.
 * `short` is the bare number for a narrow row (ADR-261), with the full label in the tooltip.
 */
export function CopilotUsageMark({ usage, prefix, short }: { usage: CopilotUsage | null; prefix?: string; short?: boolean }) {
  if (usage === null) return null;
  if (short)
    return (
      <span className="text-muted-foreground shrink-0 font-mono text-2xs" title={`${usageLabel(usage)}\n${usageDetails(usage)}`}>
        {usageShortLabel(usage)}
      </span>
    );
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs" title={usageDetails(usage)}>
      <Coins className="size-3" aria-hidden />
      {prefix === undefined ? usageLabel(usage) : `${prefix} ${usageLabel(usage)}`}
    </span>
  );
}
