import { type MergeRequestThread, mergeRequestsApi, type MergeRequestThreads as Read } from "@trackwall/protocol";
import { ExternalLink, MessagesSquare, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { firstPicks, sendBlocker, threadPlace, threadsSummary } from "@/lib/merge-request-threads";
import { deliveryMessage } from "@/lib/review-drafts";
import { useAction } from "@/lib/use-action";

/**
 * The unresolved threads of a task's open merge request (ADR-255), read from the repo host when the user asks: each with
 * where it is and what its reviewers wrote, picked or not, and "Send to agent", which hands the picked ones to the
 * task's agent like a review. Replying and resolving stay on the repo host, a link away.
 */
export function MergeRequestThreads({ conn, task, open }: { conn: Connection; task: string; open: (url: string) => void }) {
  const [read, setRead] = useState<Read>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<string>();
  const load = useAction(
    () => post(conn, mergeRequestsApi.threads, { task }),
    (threads) => {
      setRead(threads);
      setPicked(firstPicks(threads.threads));
      setSent(undefined);
    },
  );
  const send = useAction(
    () => post(conn, mergeRequestsApi.sendThreads, { task, threads: [...picked] }),
    ({ delivery, sent }) => setSent(deliveryMessage(delivery, sent === 1 ? "the thread" : `the ${sent} threads`)),
  );
  const toggle = (id: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const blocker = sendBlocker(picked.size);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
        <span className="flex-1 truncate">{read ? threadsSummary(read) : "Review threads on the repo host"}</span>
        <Button variant="outline" size="sm" onClick={() => load.run()} disabled={load.pending}>
          <MessagesSquare /> {load.pending ? "Reading threads…" : read ? "Read again" : "Read threads"}
        </Button>
        {read && read.threads.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => send.run()}
            disabled={send.pending || blocker !== null}
            title={blocker ?? undefined}
          >
            <Send /> {send.pending ? "Sending…" : `Send to agent (${picked.size})`}
          </Button>
        )}
      </div>
      {sent && <p className="text-muted-foreground text-xs">{sent}</p>}
      {(load.error ?? send.error) && <p className="text-destructive text-xs">{load.error ?? send.error}</p>}
      {read && read.threads.length > 0 && (
        <ul aria-label="Unresolved threads" className="flex max-h-72 flex-col gap-1 overflow-auto">
          {read.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} picked={picked.has(thread.id)} onToggle={() => toggle(thread.id)} open={open} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  picked,
  onToggle,
  open,
}: {
  thread: MergeRequestThread;
  picked: boolean;
  onToggle: () => void;
  open: (url: string) => void;
}) {
  const [first, ...replies] = thread.notes;
  const place = threadPlace(thread);
  const more = replies.length + thread.moreNotes;
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs">
      <input
        type="checkbox"
        className="accent-primary mt-0.5 size-4 shrink-0"
        aria-label={`Send the thread on ${place}`}
        checked={picked}
        onChange={onToggle}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground truncate font-mono">{place}</span>
        {first && (
          <span className="line-clamp-3 break-words">
            <span className="text-muted-foreground">{`${first.author}: `}</span>
            {first.text}
          </span>
        )}
        {more > 0 && <span className="text-muted-foreground">{more === 1 ? "1 reply" : `${more} replies`}</span>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto shrink-0 p-0"
        aria-label={`Open the thread on ${place}`}
        title={thread.url}
        onClick={() => open(thread.url)}
      >
        <ExternalLink />
      </Button>
    </li>
  );
}
