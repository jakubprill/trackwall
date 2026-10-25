import { countLabel } from "@trackwall/protocol";
import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskReview } from "@/lib/use-task-review";

/**
 * The review above a task's changes (ADR-62): the draft comments, each with its file and line, and one button that sends
 * them all to the task's agent; after sending, when the agent gets them. Nothing until the first comment. It stays at the
 * top while the diff scrolls, so the drafts and the button are in sight from any line.
 */
export function ReviewBar({ review }: { review: TaskReview }) {
  const { drafts, sentMessage, sendError, sending } = review;
  if (drafts.length === 0 && !sentMessage && !sendError) return null;
  return (
    <section aria-label="Review for the agent" className="bg-card sticky -top-4 z-10 flex flex-col gap-2 rounded-md border p-3 shadow-xs">
      {drafts.length > 0 && (
        <>
          <ul className="flex flex-col gap-1">
            {drafts.map(({ id, comment }) => (
              <li key={id} className="flex min-w-0 items-start gap-2 text-sm">
                <span className="text-muted-foreground shrink-0 font-mono text-xs" title={comment.path}>
                  {fileName(comment.path)}:{comment.line}
                  {comment.side === "old" && " (removed)"}
                </span>
                <span className="min-w-0 flex-1 truncate" title={comment.text}>
                  {comment.text}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label={`Remove the comment on line ${comment.line} of ${comment.path}`}
                  disabled={sending}
                  onClick={() => review.remove(id)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={review.send} disabled={sending}>
              <Send /> Send {countLabel(drafts.length, { one: "comment", other: "comments" })} to the agent
            </Button>
            <span className="text-muted-foreground text-xs">The agent reads them all at once and addresses each one.</span>
          </div>
        </>
      )}
      {sendError && <p className="text-destructive text-xs">{sendError}</p>}
      {sentMessage && !sendError && <p className="text-muted-foreground text-xs">{sentMessage}</p>}
    </section>
  );
}

/** The last segment of a path with `/`: the list stays readable with deep Java packages, and the full path is in the tooltip. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
