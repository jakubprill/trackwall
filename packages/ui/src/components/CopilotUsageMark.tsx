import type { CopilotUsage } from "@trackwall/protocol";
import { Coins } from "lucide-react";
import { usageDetails, usageLabel } from "@/lib/copilot-usage";

/** What a conversation used (ADR-190), as a quiet mark with its details on hover; nothing before the first model call. */
export function CopilotUsageMark({ usage, prefix }: { usage: CopilotUsage | null; prefix?: string }) {
  if (usage === null) return null;
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs" title={usageDetails(usage)}>
      <Coins className="size-3" aria-hidden />
      {prefix === undefined ? usageLabel(usage) : `${prefix} ${usageLabel(usage)}`}
    </span>
  );
}
