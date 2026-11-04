import { Code, Ellipsis, MessageSquare, MessageSquarePlus, Quote } from "lucide-react";
import type { LineAnnotations } from "@/components/ChangesDiff";
import { CommentForm, commentedLines, REVIEW_FULL_TITLE } from "@/components/LineComments";
import { Button } from "@/components/ui/button";
import type { DiffAnchor, DiffLine } from "@/lib/diff-lines";
import { inFileAsLeft } from "@/lib/diff-panel";
import { anchorKey } from "@/lib/review-drafts";
import type { TaskReview } from "@/lib/use-task-review";
import { cn } from "@/lib/utils";

/**
 * The actions on a line of the diff panel (ADR-107): a button in front of each line of a change picks it, and under the
 * picked line "Comment" adds a comment to the task's review (only for a task, whose review the panel shares with the
 * "Changes" tab), "Open in VS Code" opens the file at that line, and "Ask about this" puts the line into the message.
 * The first two only on a line of the file as it is now (`current` and `inFileAsLeft`); a failed open shows under the
 * line it was for.
 */
export function diffLineActions({
  current,
  change,
  picked,
  onPick,
  review,
  onOpen,
  openError,
  onAsk,
}: {
  /** This change is the file's last one in the conversation, so its new lines are numbered as the file is now. */
  current: boolean;
  /** The tool call whose change this is, which a picked line's key starts with. */
  change: string;
  /** The key of the picked line: its change and its `anchorKey`. */
  picked: string | null;
  onPick: (key: string | null) => void;
  review: TaskReview | undefined;
  onOpen: (key: string, anchor: DiffAnchor) => void;
  /** Why opening the picked line failed. */
  openError: string | undefined;
  onAsk: (anchor: DiffAnchor, line: DiffLine) => void;
}): LineAnnotations {
  const commented = commentedLines(review);
  return {
    gutter: (anchor) => {
      const key = `${change} ${anchorKey(anchor)}`;
      const marked = commented.has(anchorKey(anchor));
      return (
        <button
          type="button"
          aria-pressed={picked === key}
          aria-label={`Actions for line ${anchor.line} of ${anchor.path}`}
          title="Comment, open in VS Code or ask about this line"
          className={cn(
            picked === key || marked ? "text-primary" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          onClick={() => onPick(picked === key ? null : key)}
        >
          {marked ? <MessageSquare className="size-3" /> : <Ellipsis className="size-3" />}
        </button>
      );
    },
    below: (anchor, line) => {
      const key = `${change} ${anchorKey(anchor)}`;
      // A comment is on the file as it is now, so its form shows under the current change it was opened in.
      if (review && current && review.editing === anchorKey(anchor)) return <CommentForm anchor={anchor} line={line} review={review} />;
      if (picked !== key) return null;
      const now = current && inFileAsLeft(anchor);
      return (
        <div className="flex flex-col gap-1 py-1 pl-16 font-sans whitespace-normal">
          <div className="flex flex-wrap gap-1.5">
            {review && now && (
              <Button
                size="sm"
                variant="outline"
                disabled={review.full}
                title={review.full ? REVIEW_FULL_TITLE : undefined}
                onClick={() => {
                  // The comment form takes the place of the actions.
                  review.open(anchor);
                  onPick(null);
                }}
              >
                <MessageSquarePlus /> Comment
              </Button>
            )}
            {now && (
              <Button size="sm" variant="outline" onClick={() => onOpen(key, anchor)}>
                <Code /> Open in VS Code at {anchor.line}
              </Button>
            )}
            <Button size="sm" onClick={() => onAsk(anchor, line)}>
              <Quote /> Ask about this
            </Button>
          </div>
          {openError && <p className="text-destructive text-xs">{openError}</p>}
        </div>
      );
    },
  };
}
