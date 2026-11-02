import type { AutoReview, AutoReviewFinding } from "@trackwall/protocol";
import { MessageSquarePlus, ScanSearch, Square } from "lucide-react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { autoReviewLabel, findingComment, inDrafts } from "@/lib/auto-review";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { useTaskAutoReview } from "@/lib/use-task-auto-review";
import type { TaskReview } from "@/lib/use-task-review";

/**
 * The automatic review of a task (ADR-182) above its diff: "Review" asks Copilot CLI's review agent to read the task's
 * changes, and each finding it reports can become a review comment on its line with one click. Nothing reaches the
 * task's agent until the user sends the review, so a wrong finding costs nothing but the reading.
 */
export function TaskAutoReview({
  conn,
  task,
  patch,
  paused,
  review,
}: {
  conn: Connection;
  task: string;
  patch: string;
  paused: boolean;
  review: TaskReview;
}) {
  const state = useTaskAutoReview(conn, task, paused);
  const { review: autoReview } = state;
  return (
    <section aria-label="Automatic review" className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">Automatic review</span>
        {autoReview && <StatusLabel {...autoReviewLabel(autoReview)} />}
        <span className="text-muted-foreground flex-1 truncate text-xs">
          {autoReview
            ? `started ${relativeTime(autoReview.startedAt, new Date())}${autoReview.trigger === "report" ? " after the agent's report" : ""}`
            : "Copilot CLI reads the changes and reports what looks wrong. It costs model credits."}
        </span>
        {state.error && <span className="text-destructive max-w-xs truncate text-xs">{state.error}</span>}
        {state.running ? (
          <Button variant="outline" size="sm" onClick={state.cancel} disabled={state.cancelling}>
            <Square /> Cancel
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={state.start}
            disabled={state.starting}
            title="review the task's changes with Copilot CLI"
          >
            <ScanSearch /> {autoReview ? "Review again" : "Review"}
          </Button>
        )}
      </div>
      {autoReview && <ReviewResult autoReview={autoReview} patch={patch} review={review} />}
    </section>
  );
}

function ReviewResult({ autoReview, patch, review }: { autoReview: AutoReview; patch: string; review: TaskReview }) {
  const { findings, message, text, diffTruncated, state } = autoReview;
  return (
    <>
      {diffTruncated && <p className="text-warning text-xs">The change was too large: the reviewer got only its first part.</p>}
      {message && <p className="text-muted-foreground text-xs">{message}</p>}
      {findings.length > 0 && (
        <ul aria-label="Findings" className="flex flex-col gap-2">
          {findings.map((finding, i) => (
            // Two findings may share a title and line, so the position tells them apart.
            <Finding key={`${i}:${finding.title}`} finding={finding} patch={patch} review={review} />
          ))}
        </ul>
      )}
      {state === "done" && text !== "" && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">The reviewer's answer</summary>
          <pre className="mt-1 max-h-64 overflow-auto font-mono whitespace-pre-wrap">{text}</pre>
        </details>
      )}
    </>
  );
}

function Finding({ finding, patch, review }: { finding: AutoReviewFinding; patch: string; review: TaskReview }) {
  const comment = findingComment(finding, patch);
  const added = comment !== null && inDrafts(comment, review.drafts);
  const place = finding.path === null ? null : finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        {finding.severity && <span className="text-muted-foreground shrink-0 text-xs uppercase">{finding.severity}</span>}
        <span className="min-w-0 flex-1 truncate font-medium" title={finding.title}>
          {finding.title}
        </span>
        {place && (
          <span className="text-muted-foreground shrink-0 font-mono text-xs" title={place}>
            {place}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={comment === null || added || review.full || review.sending}
          title={addTitle(comment !== null, added, review.full)}
          onClick={() => comment && review.add(comment)}
        >
          <MessageSquarePlus /> {added ? "In the review" : "Add to review"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs whitespace-pre-wrap">{finding.text}</p>
    </li>
  );
}

function addTitle(onShownLine: boolean, added: boolean, full: boolean): string {
  if (!onShownLine) return "The finding names no line the diff shows; tell the agent in the task's session instead";
  if (added) return "Already in the review above the diff";
  if (full) return "The review is full; send it first";
  return "Add as a review comment on its line, to send to the agent with the others";
}
