import { agentsApi, type TaskRunSettings as Review } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { runSettingsAcceptance } from "@/lib/run-settings-review";
import { useAction } from "@/lib/use-action";
import { CHANGE_LABEL, ChangedText } from "./ChangedText.tsx";

/**
 * The git settings of a task's repo that make git run a program, changed since a task in the sandbox started (ADR-181
 * addendum): Trackwall runs no git in the repo until they are undone or the user accepts them here, ending its tasks
 * included. The acceptance names the version on screen by its digest, so a change made after the review is refused; a
 * change Trackwall cannot check cannot be accepted, and one whose text is not shown only after the user read it.
 */
export function TaskRunSettings({
  conn,
  task,
  review,
  onAccepted,
  onCancel,
}: {
  conn: Connection;
  task: string;
  review: Review;
  onAccepted: () => void;
  onCancel: () => void;
}) {
  const [readHidden, setReadHidden] = useState(false);
  const { canAccept, blocked, hidden } = runSettingsAcceptance(review, readHidden);
  const accept = useAction(() => post(conn, agentsApi.acceptTaskRunSettings, { task, digest: review.digest }), onAccepted);
  return (
    <section aria-label="Changed git settings" className="flex flex-col gap-2">
      <p className="text-warning text-sm">
        Trackwall runs no git in this repo: its git settings that make git run a program changed since a task in the sandbox started.
        {!review.baselineKnown && " This task is from an older version, which did not note what they were, so here are all of them."}
      </p>
      {review.changes.map((c) => (
        <ChangedText
          key={c.place}
          label={`${CHANGE_LABEL[c.change]} ${c.place}`}
          removed={c.change === "removed"}
          content={c.content}
          notShown="Not shown here: too long, or a credential. Read it in the repo."
        />
      ))}
      <p className="text-muted-foreground text-xs">
        A hook or a filter runs as you, outside the sandbox. If you did not make this change yourself (for example with npm install), cancel
        and undo it in the repo.
      </p>
      {blocked.length > 0 && (
        <p className="text-warning text-xs">
          {blocked.join(", ")} can make git run a program Trackwall does not check, so it cannot be accepted here: undo it in the repo.
        </p>
      )}
      {blocked.length === 0 && hidden.length > 0 && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary size-4 shrink-0"
            checked={readHidden}
            onChange={(e) => setReadHidden(e.target.checked)}
          />
          I have read in the repo what is not shown here
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={accept.pending || !canAccept} onClick={() => accept.run()}>
          Accept these settings
        </Button>
        <Button variant="ghost" size="sm" disabled={accept.pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {accept.error && <p className="text-destructive text-sm whitespace-pre-wrap">{accept.error}</p>}
    </section>
  );
}
