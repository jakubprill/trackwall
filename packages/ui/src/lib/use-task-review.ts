import { agentsApi, REVIEW_COMMENTS_MAX, type ReviewComment } from "@trackwall/protocol";
import { useRef, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { DiffAnchor } from "./diff-lines.ts";
import { anchorKey, deliveryMessage, type ReviewDraft } from "./review-drafts.ts";
import { useAction } from "./use-action.ts";

/**
 * The review the user writes in a task's "Changes" tab (ADR-62): draft comments, the line whose form is open, and
 * sending them all to the task's agent at once. Held by the task panel, so that switching tabs keeps the drafts.
 */
export function useTaskReview(conn: Connection, task: string) {
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const nextId = useRef(0);
  // The drafts being sent: a comment added during the request stays for the next review.
  const sentIds = useRef<ReadonlySet<number>>(new Set());
  const send = useAction(
    (comments: ReviewComment[]) => post(conn, agentsApi.sendReview, { task, comments }),
    (result) => {
      setDrafts((current) => current.filter((d) => !sentIds.current.has(d.id)));
      setSentMessage(deliveryMessage(result.delivery));
    },
  );
  return {
    drafts,
    /** The key (`anchorKey`) of the line whose comment form is open. */
    editing,
    full: drafts.length >= REVIEW_COMMENTS_MAX,
    sentMessage,
    sending: send.pending,
    sendError: send.error,
    open: (anchor: DiffAnchor) => setEditing(anchorKey(anchor)),
    cancel: () => setEditing(null),
    add: (comment: ReviewComment) => {
      setDrafts((current) => [...current, { id: nextId.current++, comment }]);
      setEditing(null);
      setSentMessage(null);
    },
    remove: (id: number) => setDrafts((current) => current.filter((d) => d.id !== id)),
    send: () => {
      sentIds.current = new Set(drafts.map((d) => d.id));
      send.run(drafts.map((d) => d.comment));
    },
  };
}

export type TaskReview = ReturnType<typeof useTaskReview>;
