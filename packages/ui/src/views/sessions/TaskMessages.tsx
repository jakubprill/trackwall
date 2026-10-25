import type { Session, TaskMessage } from "@trackwall/protocol";
import { relativeTime } from "@/lib/format";
import { proposerName } from "@/lib/session-entries";

/**
 * The messages the task's proposer sent its session (ADR-68), oldest first, so the user sees what the agents told each
 * other; a message the task's agent has not read yet says so. Nothing while there are none.
 */
export function TaskMessages({ messages, sessions }: { messages: readonly TaskMessage[]; sessions: readonly Session[] }) {
  if (messages.length === 0) return null;
  const now = new Date();
  return (
    <section aria-label="Messages to the task's session" className="flex flex-col gap-1 border-b px-4 py-3">
      <span className="hud-label">Messages</span>
      {/* A few at most: more scroll instead of squeezing the session terminal below. */}
      <ol className="flex max-h-40 flex-col gap-2 overflow-auto">
        {messages.map((message) => (
          <li key={message.id} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">
              {`from ${proposerName(message.from, sessions)} · ${relativeTime(message.sentAt, now)}`}
              {message.readAt === null && <span className="text-primary"> · not read yet</span>}
            </span>
            <p className="max-w-prose text-sm whitespace-pre-wrap">{message.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
