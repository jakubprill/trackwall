import { Fragment } from "react";
import type { LineAnnotations } from "@/components/ChangesDiff";
import type { Change } from "@/lib/diff-lines";
import { DIFF_LINE_CLASSES } from "@/lib/diff-lines";
import { cn } from "@/lib/utils";

/**
 * A change coloured by the kind of each line, as a tool call, an approval and the diff panel in the conversation view
 * show it, with a note when it goes on beyond what is shown. With `lineNumbers` each line has its number in the file:
 * the new file's, or the old one's for a removed line; `annotations` add to the lines of a change what they add in
 * the "Changes" view (the diff panel's line actions).
 */
export function PatchLines({
  change,
  lineNumbers = false,
  annotations,
}: {
  change: Change;
  lineNumbers?: boolean;
  annotations?: LineAnnotations;
}) {
  return (
    <>
      <pre className="overflow-x-auto font-mono text-xs leading-5">
        {change.lines.map((line) => (
          <Fragment key={line.offset}>
            <div className={cn("group whitespace-pre", lineNumbers || annotations ? "flex pr-3" : "px-3", DIFF_LINE_CLASSES[line.kind])}>
              {lineNumbers && (
                <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{line.anchor?.line ?? ""}</span>
              )}
              {annotations && <span className="w-5 shrink-0">{line.anchor && annotations.gutter(line.anchor)}</span>}
              {line.text || " "}
            </div>
            {annotations && line.anchor && annotations.below(line.anchor, line)}
          </Fragment>
        ))}
      </pre>
      {change.more && <p className="text-muted-foreground px-3 pt-1.5 text-xs">The change is longer; showing its beginning.</p>}
    </>
  );
}
