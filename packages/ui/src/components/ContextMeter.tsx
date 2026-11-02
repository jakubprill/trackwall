import type { ContextUse } from "@trackwall/protocol";
import { contextMeter } from "@/lib/conversation";

/** How much of the model's context window the conversation uses; it turns yellow when the window is nearly full. */
export function ContextMeter({ context }: { context: ContextUse }) {
  const { percent, tone } = contextMeter(context);
  const title = `Context used: ${context.used.toLocaleString("en")} of ${context.size.toLocaleString("en")} tokens`;
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 font-mono" title={title}>
      <span className="bg-secondary flex h-1.5 w-16 overflow-hidden rounded-full" aria-hidden>
        <span className={tone === "warning" ? "bg-warning h-full" : "bg-primary h-full"} style={{ width: `${percent}%` }} />
      </span>
      <span className={tone === "warning" ? "text-warning" : undefined}>
        <span className="sr-only">Context used: </span>
        {percent}%
      </span>
    </span>
  );
}
