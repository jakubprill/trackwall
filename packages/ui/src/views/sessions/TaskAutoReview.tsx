import { type AutoReview, type AutoReviewFinding, type AutoReviewKind, countLabel } from "@trackwall/protocol";
import { BookOpenText, ListChecks, MessageSquarePlus, ScanSearch, Square } from "lucide-react";
import { type ReactNode, Suspense, useMemo } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { AUTO_REVIEW_TEXTS, autoReviewLabel, findingComment, inDrafts, type ShownLines, shownLines } from "@/lib/auto-review";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { useTaskAutoReview } from "@/lib/use-task-auto-review";
import type { TaskReview } from "@/lib/use-task-review";

const KIND_ICONS: Record<AutoReviewKind, ReactNode> = { code: <ScanSearch />, rules: <ListChecks />, explain: <BookOpenText /> };

/**
 * An automatic review of a task above its diff: "Explain this diff" asks Copilot CLI to explain the task's changes
 * (ADR-250), "Review" asks Copilot CLI's review agent to read them (ADR-182), "Check rules" asks Copilot CLI whether
 * they keep the repo's rules (ADR-234), and each finding a review or a check reports can become a review comment on its
 * line with one click. Nothing reaches the task's agent until the user sends the review, so a wrong finding costs
 * nothing but the reading.
 */
export function TaskAutoReview({
  conn,
  task,
  kind,
  patch,
  paused,
  review,
}: {
  conn: Connection;
  task: string;
  kind: AutoReviewKind;
  patch: string;
  paused: boolean;
  review: TaskReview;
}) {
  const state = useTaskAutoReview(conn, task, kind, paused);
  const { review: autoReview } = state;
  const texts = AUTO_REVIEW_TEXTS[kind];
  return (
    <section aria-label={texts.title} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">{texts.title}</span>
        {autoReview && <StatusLabel {...autoReviewLabel(autoReview)} />}
        <span className="text-muted-foreground flex-1 truncate text-xs">
          {autoReview
            ? `started ${relativeTime(autoReview.startedAt, new Date())}${autoReview.trigger === "report" ? " after the agent's report" : ""}`
            : texts.idle}
        </span>
        {state.error && <span className="text-destructive max-w-xs truncate text-xs">{state.error}</span>}
        {state.running ? (
          <Button variant="outline" size="sm" onClick={state.cancel} disabled={state.cancelling}>
            <Square /> Cancel
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={state.start} disabled={state.starting} title={texts.startTitle}>
            {KIND_ICONS[kind]} {autoReview ? texts.again : texts.start}
          </Button>
        )}
      </div>
      {autoReview &&
        (autoReview.kind === "explain" ? (
          <Explanation conn={conn} autoReview={autoReview} />
        ) : (
          <ReviewResult autoReview={autoReview} patch={patch} review={review} />
        ))}
    </section>
  );
}

function ReviewResult({ autoReview, patch, review }: { autoReview: AutoReview; patch: string; review: TaskReview }) {
  const { findings, message, text, diffTruncated, state, ruleFiles } = autoReview;
  // Read once per diff, not per finding on every poll.
  const shown = useMemo(() => shownLines(patch), [patch]);
  return (
    <>
      <ReviewNotes diffTruncated={diffTruncated} message={message} />
      {findings.length > 0 && (
        <ul aria-label="Findings" className="flex flex-col gap-2">
          {findings.map((finding, i) => (
            // Two findings may share a title and line, so the position tells them apart.
            <Finding key={`${i}:${finding.title}`} finding={finding} shown={shown} review={review} />
          ))}
        </ul>
      )}
      {ruleFiles.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">
            {countLabel(ruleFiles.length, { one: "rule file", other: "rule files" })} from the task's base commit
          </summary>
          <ul className="mt-1 font-mono">
            {ruleFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
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

/** What a review of any kind says about how it ran: a cut diff, and why it failed or what it was refused. */
function ReviewNotes({ diffTruncated, message }: Pick<AutoReview, "diffTruncated" | "message">) {
  return (
    <>
      {diffTruncated && <p className="text-warning text-xs">The change was too large: Copilot CLI got only its first part.</p>}
      {message && <p className="text-muted-foreground text-xs">{message}</p>}
    </>
  );
}

/**
 * The explanation as Copilot CLI wrote it, in Markdown like an agent's answer (untrusted: no raw HTML, no diagrams), or
 * as plain text until the formatter has loaded or if it fails.
 */
function Explanation({ conn, autoReview }: { conn: Connection; autoReview: AutoReview }) {
  const { message, text, diffTruncated, state } = autoReview;
  const plain = <p className="text-sm whitespace-pre-wrap">{text}</p>;
  return (
    <>
      <ReviewNotes diffTruncated={diffTruncated} message={message} />
      {state === "done" && (
        <ErrorBoundary fallback={() => plain}>
          <Suspense fallback={plain}>
            <LazyMarkdown conn={conn} text={text} source="agent" />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}

function Finding({ finding, shown, review }: { finding: AutoReviewFinding; shown: ShownLines; review: TaskReview }) {
  const comment = findingComment(finding, shown);
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
