import { REVIEW_COMMENT_MAX, REVIEW_COMMENTS_MAX } from "@trackwall/protocol";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import type { LineAnnotations } from "@/components/ChangesDiff";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DiffAnchor, DiffLine } from "@/lib/diff-lines";
import { anchorKey, lineComment } from "@/lib/review-drafts";
import type { TaskReview } from "@/lib/use-task-review";
import { cn } from "@/lib/utils";

/**
 * Review comments on the lines of a task's changes (ADR-62): a button in front of every line of a change opens a form
 * under it, and a line with a draft comment keeps its mark. The drafts go to the agent from the review bar. While a form
 * is open the diff does not refresh (`TaskChangesView`), so the form stays under the line it was opened on.
 */
export function reviewAnnotations(review: TaskReview): LineAnnotations {
  const commented = new Set(review.drafts.map((d) => anchorKey(d.comment)));
  return {
    gutter: (anchor) => <CommentButton anchor={anchor} commented={commented.has(anchorKey(anchor))} review={review} />,
    below: (anchor, line) => review.editing === anchorKey(anchor) && <CommentForm anchor={anchor} line={line} review={review} />,
  };
}

function CommentButton({ anchor, commented, review }: { anchor: DiffAnchor; commented: boolean; review: TaskReview }) {
  return (
    <button
      type="button"
      className={cn(commented ? "text-primary" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
      aria-label={`Comment on line ${anchor.line} of ${anchor.path}`}
      title={
        review.full ? `A review holds at most ${REVIEW_COMMENTS_MAX} comments; send these first` : "Comment on this line for the agent"
      }
      disabled={review.full}
      onClick={() => review.open(anchor)}
    >
      {commented ? <MessageSquare className="size-3" /> : <MessageSquarePlus className="size-3" />}
    </button>
  );
}

/** Ctrl+Enter (⌘+Enter on macOS) adds the comment, Esc closes the form. */
function CommentForm({ anchor, line, review }: { anchor: DiffAnchor; line: DiffLine; review: TaskReview }) {
  const [text, setText] = useState("");
  const add = () => {
    if (text.trim() !== "") review.add(lineComment(anchor, line.text, text));
  };
  return (
    <form
      className="bg-background my-1 ml-6 flex max-w-prose flex-col gap-2 rounded-md border p-2 font-sans whitespace-normal"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <Textarea
        autoFocus
        aria-label={`Comment on line ${anchor.line} of ${anchor.path}`}
        placeholder="What should the agent change here?"
        value={text}
        maxLength={REVIEW_COMMENT_MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") review.cancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            add();
          }
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={text.trim() === ""}>
          Add comment
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={review.cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
