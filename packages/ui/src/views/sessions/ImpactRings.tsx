import { type ImpactedRepo, MAX_IMPACT_RINGS } from "@trackwall/protocol";
import { IMPACT_RING_STROKE, type ImpactPoint } from "@/lib/task-impact";
import { cn } from "@/lib/utils";

const NODE_WIDTH = 172;
const NODE_HEIGHT = 30;
/** Characters of a repo name that fit a node; the full name is in its tooltip. */
const NAME_CHARS = 16;

/**
 * The drawing of a task's impact (ADR-147): the task's repo in the centre, each ring of reached repos on its own
 * circle, a line from every reached repo to the repos it calls in the ring inside it, dashed where the change may not
 * reach. Hovering a repo, here or in the list, lights its lines. SVG scaled to the column, no graph library, like the
 * Overview graph (ADR-29).
 */
export function ImpactRings({
  repo,
  points,
  impact,
  ringGap,
  selected,
  onSelect,
}: {
  repo: string;
  points: readonly ImpactPoint[];
  impact: readonly ImpactedRepo[];
  ringGap: number;
  selected: string | undefined;
  onSelect: (repo: string | undefined) => void;
}) {
  const rings = Math.max(1, ...impact.map((r) => r.ring));
  const half = rings * ringGap + NODE_WIDTH / 2 + 8;
  const at = new Map(points.map((p) => [p.repo, p]));
  const lines = impact.flatMap((r) => r.uses.map((used) => ({ from: r, to: used })));
  return (
    <svg
      viewBox={`${-half} ${-half} ${2 * half} ${2 * half}`}
      className="surface aspect-square w-full max-w-[34rem] self-start xl:sticky xl:top-0"
      role="img"
      aria-label={`Impact of the change in ${repo}: ${impact.length} repos in ${rings} rings`}
    >
      {Array.from({ length: Math.min(rings, MAX_IMPACT_RINGS) }, (_, i) => (
        <circle
          key={`ring-${i + 1}`}
          r={(i + 1) * ringGap}
          fill="none"
          strokeDasharray="2 6"
          className={cn(IMPACT_RING_STROKE[i + 1], "opacity-50")}
        />
      ))}
      {lines.map(({ from, to }) => {
        const a = at.get(from.repo);
        const b = at.get(to);
        if (!a || !b) return null;
        const lit = selected === from.repo || selected === to;
        return (
          <line
            key={`${from.repo}>${to}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            strokeWidth={lit ? 2 : 1.25}
            strokeDasharray={from.sure ? undefined : "5 4"}
            className={cn(IMPACT_RING_STROKE[from.ring], selected !== undefined && !lit && "opacity-25", "transition-opacity")}
          />
        );
      })}
      {points.map((p) => {
        const reached = impact.find((r) => r.repo === p.repo);
        return (
          <Node
            key={p.repo}
            point={p}
            sure={reached?.sure ?? true}
            dimmed={selected !== undefined && !nearOf(selected, p.repo, impact)}
            onSelect={onSelect}
          />
        );
      })}
    </svg>
  );
}

/** Whether `repo` is the selected one or a repo it calls or is called by. */
function nearOf(selected: string, repo: string, impact: readonly ImpactedRepo[]): boolean {
  if (selected === repo) return true;
  const uses = (r: string) => impact.find((i) => i.repo === r)?.uses ?? [];
  return uses(selected).includes(repo) || uses(repo).includes(selected);
}

function Node({
  point,
  sure,
  dimmed,
  onSelect,
}: {
  point: ImpactPoint;
  sure: boolean;
  dimmed: boolean;
  onSelect: (repo: string | undefined) => void;
}) {
  const name = point.repo.length > NAME_CHARS ? `${point.repo.slice(0, NAME_CHARS - 1)}…` : point.repo;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering only lights the lines; the list next to the drawing has the same repos as buttons.
    <g
      transform={`translate(${point.x} ${point.y})`}
      className={cn("transition-opacity", dimmed && "opacity-35")}
      onMouseEnter={() => onSelect(point.repo)}
      onMouseLeave={() => onSelect(undefined)}
    >
      <title>{point.ring === 0 ? `${point.repo}: the task's repo` : `${point.repo}: ring ${point.ring}${sure ? "" : ", maybe"}`}</title>
      <rect
        x={-NODE_WIDTH / 2}
        y={-NODE_HEIGHT / 2}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={3}
        strokeWidth={point.ring === 0 ? 1.75 : 1.25}
        strokeDasharray={sure ? undefined : "4 3"}
        className={cn("fill-card", IMPACT_RING_STROKE[point.ring])}
      />
      <text textAnchor="middle" dominantBaseline="central" className="fill-foreground font-mono text-base">
        {name}
      </text>
    </g>
  );
}
