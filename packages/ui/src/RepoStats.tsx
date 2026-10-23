import type { RepoStatusOk } from "@trackwall/protocol";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { StatusDot } from "@/components/StatusDot";
import { changesLabel, relativeTime } from "@/lib/format";

/** Kafelki stanu w nagłówku repo: gałąź, upstream, katalog roboczy i ostatni commit (§4.5). */
export function RepoStats({ status }: { status: RepoStatusOk }) {
  const changes = changesLabel(status.changes);
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
      <Stat label="Gałąź">
        <span className="font-mono" title={status.branch ?? undefined}>
          {status.branch ?? "odłączony HEAD"}
        </span>
      </Stat>
      <Stat label="Upstream">
        {status.upstream ? (
          <span className="flex items-center gap-2 font-mono" title={`względem ${status.upstream.name}`}>
            <span className="flex items-center gap-0.5">
              <ArrowUp className="text-muted-foreground size-3.5" />
              {status.upstream.ahead}
            </span>
            <span className="flex items-center gap-0.5">
              <ArrowDown className="text-muted-foreground size-3.5" />
              {status.upstream.behind}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">{status.upstream.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">brak</span>
        )}
      </Stat>
      <Stat label="Katalog roboczy">
        <span className="flex items-center gap-2">
          <StatusDot tone={changes ? "warning" : "ok"} />
          {changes ?? "czysto"}
        </span>
      </Stat>
      <Stat label="Ostatni commit">
        {status.head ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate" title={status.head.subject}>
              {status.head.subject}
            </span>
            <span className="text-muted-foreground truncate text-xs" title={status.head.date}>
              {status.head.author}, {relativeTime(status.head.date, new Date())}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">brak commitów</span>
        )}
      </Stat>
    </dl>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-card flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2">
      <dt className="hud-label">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  );
}
