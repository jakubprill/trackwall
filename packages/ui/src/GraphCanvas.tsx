import type { GraphNode, RepoGraph } from "@trackwall/protocol";
import { useMemo } from "react";
import { countLabel } from "@/lib/format";
import { type EdgePair, edgePath, type GraphLayout, NODE_HEIGHT, NODE_WIDTH, type NodeBox, neighbourhood } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

/** Margines wokół rysunku, żeby świecące krawędzie i kropki przy krawędzi nie były ucięte. */
const PADDING = 24;
/** Ile tagów zmieścić pod nazwą repo; reszta jest w panelu szczegółów. */
const NODE_TAGS = 2;

/**
 * Graf połączeń (ADR-29): repo jako karty HUD w kolumnach, krawędzie jako krzywe w SVG pod nimi (od repo, które
 * używa, do używanego), ręczne krawędzie przerywane. Wybór repo podświetla jego sąsiedztwo, a resztę przygasza.
 */
export function GraphCanvas({
  graph,
  layout,
  selected,
  onSelect,
}: {
  graph: RepoGraph;
  layout: GraphLayout;
  selected: string | undefined;
  onSelect: (repo: string) => void;
}) {
  const near = useMemo(() => (selected === undefined ? undefined : neighbourhood(selected, layout.pairs)), [selected, layout]);
  const nodes = new Map(graph.nodes.map((n) => [n.repo, n]));
  const incoming = new Map<string, number>();
  for (const p of layout.pairs) incoming.set(p.to, (incoming.get(p.to) ?? 0) + 1);

  if (graph.nodes.length === 0) {
    return <Hint>The projects folder has no repos yet. Set it in Settings or clone a repo in Repos.</Hint>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {layout.pairs.length === 0 && (
        <Hint>
          No connections found: no repo uses a package built in another. Add connections the cards cannot see in workspace.yaml (the graph
          key).
        </Hint>
      )}
      {layout.pairs.length > 0 && (
        <div className="relative" style={{ width: layout.width + 2 * PADDING, height: layout.height + 2 * PADDING }}>
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
            <g transform={`translate(${PADDING} ${PADDING})`}>
              {layout.pairs.map((pair) => (
                <Edge key={`${pair.from}>${pair.to}`} pair={pair} layout={layout} near={near} selected={selected} />
              ))}
            </g>
          </svg>
          {[...layout.boxes.values()].map((box) => {
            const node = nodes.get(box.repo);
            return (
              node && (
                <NodeCard
                  key={box.repo}
                  box={box}
                  node={node}
                  usedBy={incoming.get(box.repo) ?? 0}
                  selected={selected === box.repo}
                  dimmed={near !== undefined && !near.has(box.repo)}
                  onSelect={() => onSelect(box.repo)}
                />
              )
            );
          })}
        </div>
      )}
      {layout.isolated.length > 0 && (
        <div className="px-4 pt-2 pb-4">
          <h3 className="hud-label pb-2">No connections</h3>
          <ul className="flex flex-wrap gap-2">
            {layout.isolated.map((repo) => (
              <li key={repo}>
                <button
                  type="button"
                  onClick={() => onSelect(repo)}
                  className={cn(
                    "surface hover:border-primary/50 px-2 py-1 font-mono text-xs transition-colors",
                    selected === repo && "border-primary text-primary",
                  )}
                >
                  {repo}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Edge({
  pair,
  layout,
  near,
  selected,
}: {
  pair: EdgePair;
  layout: GraphLayout;
  near: Set<string> | undefined;
  selected: string | undefined;
}) {
  const from = layout.boxes.get(pair.from);
  const to = layout.boxes.get(pair.to);
  if (!from || !to) return null;
  const active = selected !== undefined && (pair.from === selected || pair.to === selected);
  const dimmed = near !== undefined && !active;
  // Linia przerywana, gdy wszystkie krawędzie pary są ręczne.
  const manualOnly = pair.edges.every((e) => e.kind === "manual");
  return (
    <g className={cn("transition-opacity", dimmed && "opacity-15")}>
      <path
        d={edgePath(from, to)}
        fill="none"
        strokeWidth={active ? 1.75 : 1.25}
        strokeDasharray={manualOnly ? "6 4" : undefined}
        className={active ? "stroke-primary" : "stroke-muted-foreground/45"}
      />
      <EdgeEnd box={to} active={active} />
    </g>
  );
}

/** Kropka przy repo używanym, jak węzły na krzywych w inspiracji: kierunek bez grotów strzałek. */
function EdgeEnd({ box, active }: { box: NodeBox; active: boolean }) {
  return <circle cx={box.x} cy={box.y + NODE_HEIGHT / 2} r={3} className={active ? "fill-primary" : "fill-muted-foreground"} />;
}

function NodeCard({
  box,
  node,
  usedBy,
  selected,
  dimmed,
  onSelect,
}: {
  box: NodeBox;
  node: GraphNode;
  usedBy: number;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={node.problem ?? node.remote ?? node.repo}
      onClick={onSelect}
      style={{ left: box.x + PADDING, top: box.y + PADDING, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "surface focus-visible:ring-ring/50 absolute flex flex-col justify-center gap-0.5 px-3 text-left transition-[opacity,border-color,box-shadow] outline-none focus-visible:ring-2",
        "hover:border-primary/50",
        selected && "border-primary shadow-glow-primary",
        node.problem !== null && !selected && "border-warning/60",
        dimmed && "opacity-35",
      )}
    >
      <span className="truncate font-mono text-sm">{node.repo}</span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-2xs">
        {usedBy > 0 && (
          <span className="text-primary shrink-0" title={`Used by ${countLabel(usedBy, { one: "repo", other: "repos" })}`}>
            {`← ${usedBy}`}
          </span>
        )}
        <span className="truncate">
          {node.tags
            .slice(0, NODE_TAGS)
            .map((t) => `#${t}`)
            .join(" ")}
        </span>
      </span>
    </button>
  );
}

function Hint({ children }: { children: string | string[] }) {
  return <p className="text-muted-foreground max-w-2xl px-4 py-2 text-sm">{children}</p>;
}
