import type { Repo } from "@trackwall/protocol";
import type { StatusTone } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { changesLabel } from "@/lib/format";

/** Stan repo dla kropki na liście: niedostępne, ze zmianami w katalogu roboczym albo czyste. */
export function repoHealth(repo: Repo): { tone: StatusTone; label: string } {
  if (repo.status.kind !== "ok") return { tone: "error", label: "niedostępne" };
  return repo.status.changes > 0 ? { tone: "warning", label: "ze zmianami" } : { tone: "ok", label: "czyste" };
}

/** Stan repo w jednej linii na liście repo; szczegóły pokazuje `RepoStats` w nagłówku repo. */
export function RepoStatusBadges({ repo }: { repo: Repo }) {
  const { status } = repo;
  if (status.kind !== "ok") return <Badge variant="destructive">niedostępne</Badge>;
  const changes = changesLabel(status.changes);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs">
      <span className="min-w-0 truncate font-mono">{status.branch ?? "odłączony HEAD"}</span>
      {changes && <Badge variant="warning">{changes}</Badge>}
    </span>
  );
}
