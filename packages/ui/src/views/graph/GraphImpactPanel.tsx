import type { ChangedEndpoints } from "@trackwall/protocol";
import type { ReactNode } from "react";
import { ImpactRingBadge } from "@/components/ImpactRingBadge";
import { Badge } from "@/components/ui/badge";
import { impactSummary } from "@/lib/task-impact";

/**
 * The side panel of the "Overview" view while it lights a task's impact (ADR-147): the summary, the task's repo and
 * the reached repos by ring. A click selects a repo, which opens its details as in the plain graph.
 */
export function GraphImpactPanel({ changed, onSelect }: { changed: ChangedEndpoints; onSelect: (repo: string) => void }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <p className="hud-label">Impact</p>
        <p className="pt-1 text-sm">{impactSummary(changed)}</p>
      </header>
      <ul className="flex flex-col gap-1">
        <RepoRow repo={changed.repo} badge={<Badge>changed</Badge>} onSelect={onSelect} />
        {changed.impact.map((r) => (
          <RepoRow key={r.repo} repo={r.repo} badge={<ImpactRingBadge reached={r} />} onSelect={onSelect} />
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Ring 1 calls an endpoint the task's commits change; each further ring calls an endpoint of the ring inside it whose handler makes
        such a call. Hand a reached repo its own task from the task's Impact tab.
      </p>
    </div>
  );
}

function RepoRow({ repo, badge, onSelect }: { repo: string; badge: ReactNode; onSelect: (repo: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(repo)}
        className="hover:bg-accent/40 flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left"
      >
        {badge}
        <span className="truncate font-mono text-sm">{repo}</span>
      </button>
    </li>
  );
}
