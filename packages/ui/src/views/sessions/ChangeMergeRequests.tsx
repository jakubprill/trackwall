import { mergeRequestNumber, mergeRequestsApi, type Task } from "@trackwall/protocol";
import { Copy, Upload } from "lucide-react";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import {
  type ChangePart,
  changeLinks,
  mergeOrderNote,
  partNumber,
  pushAllConsequence,
  pushAllParts,
  pushAllSummary,
} from "@/lib/change-merge-requests";
import { copyText } from "@/lib/clipboard";
import type { Connection } from "@/lib/connection";
import { mergeRequestStatus } from "@/lib/merge-request";
import { useAction } from "@/lib/use-action";

/**
 * The merge requests of the change a task is part of (ADR-172), above the task's own: every listed part in its merge
 * order with its merge request, what to merge first, "Push all parts" after a confirmation, and "Copy links" for a
 * comment on the merge requests opened before the others. Hidden for a task that is no part of a change.
 */
export function ChangeMergeRequests({
  conn,
  task,
  parts,
  onPushed,
}: {
  conn: Connection;
  task: Task;
  parts: readonly ChangePart[] | null;
  onPushed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [summary, setSummary] = useState<ReturnType<typeof pushAllSummary>>();
  const pushAll = useAction(
    (all: readonly ChangePart[]) =>
      pushAllParts(all, {
        get: (id) => post(conn, mergeRequestsApi.get, { task: id }),
        push: (id) => post(conn, mergeRequestsApi.push, { task: id }),
      }),
    (pushes) => {
      setConfirming(false);
      setSummary(pushAllSummary(pushes));
      onPushed();
    },
  );
  if (!parts) return null;
  const note = mergeOrderNote(task, parts);
  const copy = () =>
    copyText(changeLinks(parts)).then(
      () => setCopied("Copied: paste it as a comment on the merge requests opened earlier."),
      () => setCopied("Could not copy to the clipboard."),
    );
  const run = () => {
    setSummary(undefined);
    pushAll.run(parts);
  };
  return (
    <section aria-label="Change" className="flex flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">Change</span>
        <span className="text-muted-foreground flex-1 truncate text-xs">{`Part ${partNumber(task)} · merge in this order`}</span>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={pushAll.pending || confirming}>
          <Upload /> {pushAll.pending ? "Pushing…" : "Push all parts"}
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy /> Copy links
        </Button>
      </div>
      <ol className="flex flex-col gap-1 text-xs">
        {parts.map((part) => (
          <PartRow key={part.task.id} part={part} current={part.task.id === task.id} />
        ))}
      </ol>
      {note && <StatusLabel tone={note.tone} label={note.text} />}
      {copied && <p className="text-muted-foreground text-xs">{copied}</p>}
      {confirming && (
        <div role="alertdialog" aria-label="Push all parts" className="bg-card flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm">{pushAllConsequence(parts)}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pushAll.pending} onClick={run}>
              Push all parts
            </Button>
            <Button variant="ghost" size="sm" disabled={pushAll.pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {summary && <StatusLabel tone={summary.tone} label={summary.text} />}
      {pushAll.error && <p className="text-destructive text-xs">{pushAll.error}</p>}
    </section>
  );
}

/** `1. payments  group/payments!12  merged`, the task's own part marked. */
function PartRow({ part: { task, mergeRequest }, current }: { part: ChangePart; current: boolean }) {
  return (
    <li className="flex min-w-0 items-center gap-3" aria-current={current ? "true" : undefined}>
      <span className="text-muted-foreground w-4 shrink-0 text-right">{partNumber(task)}.</span>
      <span className={current ? "truncate font-medium" : "truncate"}>{task.repo}</span>
      {mergeRequest ? (
        <span className="flex min-w-0 items-center gap-2" title={mergeRequest.url}>
          <span className="truncate">{mergeRequestNumber(mergeRequest.project, mergeRequest.number)}</span>
          <StatusLabel {...mergeRequestStatus(mergeRequest)} />
        </span>
      ) : (
        <span className="text-muted-foreground">no merge request yet</span>
      )}
    </li>
  );
}
