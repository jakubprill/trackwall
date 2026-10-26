/**
 * Strongly connected components of a directed graph (Tarjan's algorithm with an explicit stack, because a call chain in a
 * repo can be deeper than the call stack reaches). Used by the endpoint reach (ADR-82): methods that call each other in
 * a cycle reach the same calls, so each component is computed once.
 */
export interface Components {
  /** The component of each node. */
  of: number[];
  /** The members of each component; a component comes after every component it has an edge to (reverse topological order). */
  members: number[][];
}

interface Frame {
  node: number;
  /** The next outgoing edge to look at. */
  edge: number;
}

export function strongComponents(edges: readonly (readonly number[])[]): Components {
  const state = new TarjanState(edges.length);
  for (let start = 0; start < edges.length; start++) if (state.order[start] === -1) visit(start, edges, state);
  return { of: state.component, members: state.members };
}

class TarjanState {
  readonly order: number[];
  readonly low: number[];
  readonly onStack: boolean[];
  readonly component: number[];
  readonly stack: number[] = [];
  readonly members: number[][] = [];
  next = 0;

  constructor(size: number) {
    this.order = new Array<number>(size).fill(-1);
    this.low = new Array<number>(size).fill(0);
    this.onStack = new Array<boolean>(size).fill(false);
    this.component = new Array<number>(size).fill(-1);
  }

  enter(node: number): void {
    this.order[node] = this.low[node] = this.next++;
    this.stack.push(node);
    this.onStack[node] = true;
  }

  lower(node: number, to: number): void {
    this.low[node] = Math.min(this.low[node] ?? 0, to);
  }

  /** Closes `node`'s component when `node` is its root. */
  close(node: number): void {
    if (this.low[node] !== this.order[node]) return;
    const members: number[] = [];
    for (let member = this.stack.pop(); member !== undefined; member = this.stack.pop()) {
      this.onStack[member] = false;
      this.component[member] = this.members.length;
      members.push(member);
      if (member === node) break;
    }
    this.members.push(members);
  }
}

function visit(start: number, edges: readonly (readonly number[])[], state: TarjanState): void {
  const frames: Frame[] = [{ node: start, edge: 0 }];
  state.enter(start);
  for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
    const to = edges[frame.node]?.[frame.edge++];
    if (to === undefined) {
      frames.pop();
      state.close(frame.node);
      const parent = frames.at(-1);
      if (parent) state.lower(parent.node, state.low[frame.node] ?? 0);
    } else if (state.order[to] === -1) {
      state.enter(to);
      frames.push({ node: to, edge: 0 });
    } else if (state.onStack[to]) {
      state.lower(frame.node, state.order[to] ?? 0);
    }
  }
}
