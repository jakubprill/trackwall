import type { ChangedEndpoints } from "@trackwall/protocol";
import { Badge } from "@/components/ui/badge";
import { impactSummary } from "@/lib/task-impact";
import { cn } from "@/lib/utils";

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
        <RepoRow repo={changed.repo} label="changed" variant="default" onSelect={onSelect} />
        {changed.impact.map((r) => (
          <RepoRow
            key={r.repo}
            repo={r.repo}
            label={`ring ${r.ring}${r.sure ? "" : " · maybe"}`}
            variant={r.ring === 1 ? "destructive" : "outline"}
            muted={r.ring > 1}
            onSelect={onSelect}
          />
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Ring 1 calls an endpoint the task's commits change; each further ring calls an endpoint of the ring inside it whose handler makes
        such a call. Hand a reached repo its own task from the task's Impact tab.
      </p>
    </div>
  );
}

function RepoRow({
  repo,
  label,
  variant,
  muted = false,
  onSelect,
}: {
  repo: string;
  label: string;
  variant: "default" | "destructive" | "outline";
  muted?: boolean;
  onSelect: (repo: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(repo)}
        className="hover:bg-accent/40 flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left"
      >
        <Badge variant={variant} className={cn(muted && "border-warning/40 text-warning")}>
          {label}
        </Badge>
        <span className="truncate font-mono text-sm">{repo}</span>
      </button>
    </li>
  );
}
