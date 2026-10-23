import { LOG_BUFFER_RECORDS } from "@trackwall/protocol";
import { useLayoutEffect, useRef } from "react";
import type { Connection } from "@/lib/connection";
import { logLevelClass, startsRun } from "@/lib/log-tail";
import { useLogTail } from "@/lib/use-log-tail";
import { cn } from "@/lib/utils";

/** Odległość od dołu, przy której lista uznaje, że użytkownik czyta najnowsze linie i ma za nimi iść. */
const FOLLOW_SLACK_PX = 24;

/**
 * Log taska mise na żywo (§4.2, ADR-28): linie bez kolorów ANSI, kolor z poziomu rekordu, stderr oznaczony z boku.
 * Lista idzie za nowymi liniami, dopóki użytkownik nie przewinie jej w górę.
 */
export function MiseTaskLog({ conn, repo, miseTask }: { conn: Connection; repo: string; miseTask: string }) {
  const log = useLogTail(conn, { kind: "mise-task", repo, miseTask });
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  // Po każdej nowej paczce rekordów, przed malowaniem, żeby lista nie mignęła w starym miejscu.
  useLayoutEffect(() => {
    if (follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.records]);

  const onScroll = () => {
    const el = box.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };

  return (
    <div className="flex flex-col gap-1">
      {log.dropped && (
        <p className="text-muted-foreground text-xs">
          Część linii przepadła: daemon trzyma w pamięci ostatnie {LOG_BUFFER_RECORDS} linii taska, pełny log jest w pliku w katalogu stanu
          (logs/).
        </p>
      )}
      <div ref={box} onScroll={onScroll} className="bg-muted max-h-96 overflow-auto rounded-md border px-2 py-1 font-mono text-xs">
        {log.records.length === 0 ? (
          <p className="text-muted-foreground py-1">Brak linii w logu: task nic jeszcze nie wypisał w tym działaniu daemona.</p>
        ) : (
          log.records.map((record, i) => (
            <div key={record.seq}>
              {startsRun(log.records, i) && <div className="text-muted-foreground my-1 border-t pt-1">następne uruchomienie</div>}
              <div className={cn("flex gap-2 whitespace-pre-wrap break-all", logLevelClass(record.level))}>
                <span className="text-muted-foreground w-3 shrink-0 select-none" title={record.stream}>
                  {record.stream === "stderr" ? "!" : ""}
                </span>
                <span className="min-w-0">{record.msg}</span>
              </div>
            </div>
          ))
        )}
      </div>
      {log.error && <p className="text-destructive text-xs">{log.error}</p>}
    </div>
  );
}
