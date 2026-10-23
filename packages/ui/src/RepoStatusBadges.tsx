import type { Repo } from "@trackwall/protocol";
import { ArrowDown, ArrowUp, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { changesLabel, relativeTime } from "@/lib/format";

/** Stan repo w jednej linii: na liście repo (`compact`) i w nagłówku repo (z gałęzią śledzoną i ostatnim commitem). */
export function RepoStatusBadges({ repo, compact = false }: { repo: Repo; compact?: boolean }) {
  const { status } = repo;
  if (status.kind !== "ok") return <Badge variant="destructive">niedostępne</Badge>;
  const changes = changesLabel(status.changes);
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="flex min-w-0 items-center gap-1 font-mono">
        {!compact && <GitBranch className="size-3.5 shrink-0" />}
        <span className="truncate">{status.branch ?? "odłączony HEAD"}</span>
      </span>
      {!compact && status.upstream && (
        <span className="text-muted-foreground flex items-center gap-1" title={`względem ${status.upstream.name}`}>
          <ArrowUp className="size-3" />
          {status.upstream.ahead}
          <ArrowDown className="size-3" />
          {status.upstream.behind}
        </span>
      )}
      {changes ? <Badge variant="secondary">{changes}</Badge> : !compact && <Badge variant="success">czysto</Badge>}
      {!compact && (
        <span className="text-muted-foreground min-w-0 truncate">
          {status.head ? `${status.head.subject} · ${status.head.author}, ${relativeTime(status.head.date, new Date())}` : "brak commitów"}
        </span>
      )}
    </span>
  );
}
