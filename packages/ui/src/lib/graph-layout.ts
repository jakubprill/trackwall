import type { GraphEdge } from "@trackwall/protocol";

/**
 * The graph layout in the "Overview" view (ADR-29): columns from repos nobody uses (frontends) to those everybody uses
 * (libraries), like the layers of §5.5: column = the longest path from a repo without incoming edges.
 * No graph library: a few dozen repos lay out in columns in a few milliseconds, and React draws the SVG.
 */

/** All edges of one repo pair as one line in the drawing. */
export interface EdgePair {
  from: string;
  to: string;
  edges: GraphEdge[];
}

export interface NodeBox {
  repo: string;
  x: number;
  y: number;
  column: number;
}

export interface GraphLayout {
  boxes: Map<string, NodeBox>;
  pairs: EdgePair[];
  /** Repos without any edge: shown separately so that they do not widen the columns. */
  isolated: string[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 48;
const COLUMN_GAP = 88;
const ROW_GAP = 16;
/** How many times to order the columns by their neighbours; more rarely reduces the number of crossings. */
const ORDER_SWEEPS = 4;

/** Edges grouped by repo pair, in the order of first occurrence. */
export function edgePairs(edges: readonly GraphEdge[]): EdgePair[] {
  const pairs = new Map<string, EdgePair>();
  for (const edge of edges) {
    const id = `${edge.from}\u0000${edge.to}`;
    const pair = pairs.get(id) ?? { from: edge.from, to: edge.to, edges: [] };
    pair.edges.push(edge);
    pairs.set(id, pair);
  }
  return [...pairs.values()];
}

export function layoutGraph(repos: readonly string[], edges: readonly GraphEdge[]): GraphLayout {
  const pairs = edgePairs(edges);
  const connected = new Set(pairs.flatMap((p) => [p.from, p.to]));
  const nodes = repos.filter((r) => connected.has(r));
  const columns = orderColumns(groupByColumn(nodes, columnOf(nodes, pairs)), pairs);

  const tallest = Math.max(0, ...columns.map((c) => c.length));
  const boxes = new Map<string, NodeBox>();
  columns.forEach((column, c) => {
    // Shorter columns are centred against the tallest one, so that they do not stick to the top and the curves to them are shorter.
    const offset = ((tallest - column.length) * (NODE_HEIGHT + ROW_GAP)) / 2;
    column.forEach((repo, row) => {
      boxes.set(repo, { repo, column: c, x: c * (NODE_WIDTH + COLUMN_GAP), y: offset + row * (NODE_HEIGHT + ROW_GAP) });
    });
  });

  return {
    boxes,
    pairs,
    isolated: repos.filter((r) => !connected.has(r)),
    width: columns.length === 0 ? 0 : columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP,
    height: tallest === 0 ? 0 : tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP,
  };
}

/**
 * The longest path from a repo without incoming edges. A cycle (A uses B, B uses A) has no such path, so edges that go
 * back in the depth-first search are skipped when counting columns (they are still drawn).
 */
function columnOf(nodes: readonly string[], pairs: readonly EdgePair[]): Map<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const p of pairs) out.get(p.from)?.push(p.to);

  const order: string[] = [];
  const forward = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const state = new Map<string, "open" | "done">();
  const visit = (node: string) => {
    state.set(node, "open");
    for (const next of out.get(node) ?? []) {
      if (state.get(next) === "open") continue;
      forward.get(node)?.push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(node, "done");
    order.push(node);
  };
  for (const node of nodes) if (!state.has(node)) visit(node);

  // `order` is the post-order of the search, so reversed it is topological for the `forward` edges.
  const column = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const node of order.reverse()) {
    for (const next of forward.get(node) ?? []) column.set(next, Math.max(column.get(next) ?? 0, (column.get(node) ?? 0) + 1));
  }
  return column;
}

function groupByColumn(nodes: readonly string[], column: Map<string, number>): string[][] {
  const columns: string[][] = [];
  for (const node of [...nodes].sort()) {
    const c = column.get(node) ?? 0;
    columns[c] = [...(columns[c] ?? []), node];
  }
  return columns.filter((c) => c !== undefined);
}

/**
 * Order within a column by the average position of the neighbours (the barycentre heuristic), column by column,
 * alternating right and left; the first column in the first pass stays sorted by name and is the reference point.
 */
function orderColumns(columns: string[][], pairs: readonly EdgePair[]): string[][] {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
  for (const p of pairs) {
    link(p.from, p.to);
    link(p.to, p.from);
  }
  const result = columns.map((c) => [...c]);
  const position = new Map<string, number>();
  const place = (column: string[]) => {
    for (const [i, repo] of column.entries()) position.set(repo, i / Math.max(1, column.length - 1));
  };
  for (const column of result) place(column);
  const indices = result.map((_, i) => i);
  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep++) {
    const pass = sweep % 2 === 0 ? indices.slice(1) : indices.slice(0, -1).reverse();
    for (const c of pass) {
      const column = result[c] ?? [];
      const key = (repo: string) => barycentre(neighbours.get(repo) ?? [], position) ?? position.get(repo) ?? 0;
      column.sort((a, b) => key(a) - key(b) || (a < b ? -1 : 1));
      place(column);
    }
  }
  return result;
}

function barycentre(neighbours: readonly string[], position: Map<string, number>): number | undefined {
  const known = neighbours.map((n) => position.get(n)).filter((p) => p !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0) / known.length;
}

/** A curve from the right edge of the repo that uses to the left edge of the repo that is used (looping back when it goes left). */
export function edgePath(from: NodeBox, to: NodeBox): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(COLUMN_GAP / 2, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** Repos joined to `repo` by an edge in either direction, together with it (highlighting after a selection). */
export function neighbourhood(repo: string, pairs: readonly EdgePair[]): Set<string> {
  const near = new Set([repo]);
  for (const p of pairs) {
    if (p.from === repo) near.add(p.to);
    if (p.to === repo) near.add(p.from);
  }
  return near;
}
