import type { Change } from "@/lib/diff-lines";
import { DIFF_LINE_CLASSES } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/**
 * A change coloured by the kind of each line, as a tool call, an approval and the diff panel in the conversation view
 * show it, with a note when it goes on beyond what is shown. With `lineNumbers` each line has its number in the file:
 * the new file's, or the old one's for a removed line.
 */
export function PatchLines({ change, lineNumbers = false }: { change: Change; lineNumbers?: boolean }) {
  return (
    <>
      <pre className="overflow-x-auto font-mono text-xs leading-5">
        {change.lines.map((line) => (
          <div key={line.offset} className={cn("whitespace-pre", lineNumbers ? "flex pr-3" : "px-3", DIFF_LINE_CLASSES[line.kind])}>
            {lineNumbers && (
              <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{line.anchor?.line ?? ""}</span>
            )}
            {line.text || " "}
          </div>
        ))}
      </pre>
      {change.more && <p className="text-muted-foreground px-3 pt-1.5 text-xs">The change is longer; showing its beginning.</p>}
    </>
  );
}
