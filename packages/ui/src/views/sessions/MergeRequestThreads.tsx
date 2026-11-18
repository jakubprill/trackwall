import { type MergeRequestThread, mergeRequestsApi, type MergeRequestThreads as ThreadsRead } from "@trackwall/protocol";
import { ExternalLink, MessagesSquare, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { notesLeftOut, pickedThreads, sendBlocker, threadPlace, threadsSummary } from "@/lib/merge-request-threads";
import { deliveryMessage } from "@/lib/review-drafts";
import { useAction } from "@/lib/use-action";

/**
 * The unresolved threads of a task's open merge request (ADR-256), read from the repo host when the user asks: each with
 * where it is and every note of it that would reach the agent, in full, none picked at first, and "Send to agent", which
 * hands the picked ones, as the user saw them, to the task's agent like a review. Replying and resolving stay on the repo
 * host, a link away.
 */
export function MergeRequestThreads({ conn, task, open }: { conn: Connection; task: string; open: (url: string) => void }) {
  const [read, setRead] = useState<ThreadsRead>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<string>();
  const load = useAction(
    () => post(conn, mergeRequestsApi.threads, { task }),
    (threads) => {
      setRead(threads);
      setPicked(new Set());
      setSent(undefined);
    },
  );
  const send = useAction(
    () => post(conn, mergeRequestsApi.sendThreads, { task, threads: pickedThreads(read?.threads ?? [], picked) }),
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
  const place = threadPlace(thread);
  const leftOut = notesLeftOut(thread);
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs">
      <input
        type="checkbox"
        className="accent-primary mt-0.5 size-4 shrink-0"
        aria-label={`Send the thread on ${place}`}
        checked={picked}
        onChange={onToggle}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-muted-foreground truncate font-mono">{place}</span>
        {thread.notes.map((note, i) => (
          // The notes of one read never move, and two can share an author and a minute.
          <p key={`${i}:${note.at}`} className="break-words whitespace-pre-wrap">
            <span className="text-muted-foreground">{`${note.author}: `}</span>
            {note.text}
          </p>
        ))}
        {leftOut && <span className="text-muted-foreground">{leftOut}</span>}
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
