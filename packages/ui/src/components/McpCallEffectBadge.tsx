import type { McpCallEffect } from "@trackwall/protocol";
import { Badge } from "@/components/ui/badge";

/** "writes" or "runs or stops code" next to a call's tool (ADR-152), the latter in the destructive colour; a read shows nothing. */
export function McpCallEffectBadge({ effect, label }: { effect: McpCallEffect; label: string | null }) {
  if (label === null) return null;
  return <Badge variant={effect === "destructive" ? "destructive" : "secondary"}>{label}</Badge>;
}
