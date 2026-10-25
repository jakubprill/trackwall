import { LOG_BUFFER_RECORDS, type LogRecord, type LogSource } from "@trackwall/protocol";
import { memo, useLayoutEffect, useRef } from "react";
import type { Connection } from "@/lib/connection";
import { logLevelClass, startsRun } from "@/lib/log-tail";
import { useLogTail } from "@/lib/use-log-tail";
import { cn } from "@/lib/utils";

/** The distance from the bottom at which the list decides the user reads the newest lines and should follow them. */
const FOLLOW_SLACK_PX = 24;

/**
 * A mise task's live log (§4.2, ADR-28): lines without ANSI colours, coloured by the record's level, stderr marked at
 * the side. The list follows new lines until the user scrolls it up. `source` is a repo root's mise task or one run in
 * a task worktree (ADR-59).
 */
export function MiseTaskLog({ conn, source }: { conn: Connection; source: LogSource }) {
  const log = useLogTail(conn, source);
  const records = log.data?.records;
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  // After every new batch of records, before painting, so that the list does not flash in the old place.
  useLayoutEffect(() => {
    if (follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [records]);

  const onScroll = () => {
    const el = box.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };

  return (
    <div className="flex flex-col gap-1">
      {log.data?.dropped && (
        <p className="text-muted-foreground text-xs">
          Some lines were dropped: the daemon keeps only the last (at most {LOG_BUFFER_RECORDS}) lines of a mise task in memory and forgets
          them on restart. Older lines are in the log file in the state directory (logs/).
        </p>
      )}
      <div ref={box} onScroll={onScroll} className="bg-muted max-h-96 overflow-auto rounded-md border px-2 py-1 font-mono text-xs">
        {records && records.length > 0 ? (
          <LogLines records={records} />
        ) : (
          <p className="text-muted-foreground py-1">
            {records ? "No log lines: the mise task has not printed anything since the daemon started." : "Loading the log…"}
          </p>
        )}
      </div>
      {log.error && <p className="text-destructive text-xs">{log.error}</p>}
    </div>
  );
}

/** Lines repainted only when new records arrived, not on every poll. */
const LogLines = memo(function LogLines({ records }: { records: LogRecord[] }) {
  return records.map((record, i) => (
    <div key={record.seq}>
      {startsRun(records, i) && <div className="text-muted-foreground my-1 border-t pt-1">next run</div>}
      <div className={cn("flex gap-2 whitespace-pre-wrap break-all", logLevelClass(record.level))}>
        <span className="text-muted-foreground w-3 shrink-0 select-none" title={record.stream}>
          {record.stream === "stderr" ? "!" : ""}
        </span>
        <span className="min-w-0">{record.msg}</span>
      </div>
    </div>
  ));
});
