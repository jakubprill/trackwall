import type { Change } from "@/lib/diff-lines";
import { DIFF_LINE_CLASSES } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/**
 * A change coloured by the kind of each line, as a tool call and an approval in the conversation view show it, with a
 * note when it goes on beyond what is shown.
 */
export function PatchLines({ change }: { change: Change }) {
  return (
    <>
      <pre className="overflow-x-auto font-mono text-xs leading-5">
        {change.lines.map((line) => (
          <div key={line.offset} className={cn("px-3 whitespace-pre", DIFF_LINE_CLASSES[line.kind])}>
            {line.text || " "}
          </div>
        ))}
      </pre>
      {change.more && <p className="text-muted-foreground px-3 pt-1.5 text-xs">The change is longer; showing its beginning.</p>}
    </>
  );
}
