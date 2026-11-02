import { DIFF_LINE_CLASSES, type DiffLine } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/** The lines of a change coloured by their kind, as a tool call and an approval in the conversation view show them. */
export function PatchLines({ lines, className }: { lines: readonly DiffLine[]; className?: string }) {
  return (
    <pre className={cn("overflow-x-auto font-mono text-xs leading-5", className)}>
      {lines.map((line) => (
        <div key={line.offset} className={cn("px-3 whitespace-pre", DIFF_LINE_CLASSES[line.kind])}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}
