import type { ConsumedHttp, HttpCall, ProvidedEndpoint } from "@trackwall/protocol";
import type { CallFile, CallMethod, CallType, Invocation, Receiver } from "./call-index-java.ts";
import { moduleOf } from "./spring-config.ts";

/**
 * SPIKE (ADR-82 candidate, issue #120): a bounded call trace from an endpoint's handler to the HTTP calls it reaches, so
 * that `who_calls` can answer per endpoint instead of per repo. Static and without compiling: receiver types come from
 * fields, parameters and locals and from return types of methods in the repo; a call on an interface or an abstract
 * type reaches every implementation in the repo (over-approximation). The trace stops at `MAX_DEPTH` calls deep and after
 * `MAX_STEPS` methods.
 */

export const MAX_DEPTH = 12;
export const MAX_STEPS = 3000;

export interface TraceLimits {
  maxDepth: number;
  maxSteps: number;
}

export interface ReachedCall {
  client: string;
  via: ConsumedHttp["via"];
  app: string | null;
  url: string | null;
  call: HttpCall;
  /** Methods from the handler to the call (`Type.method`), the handler first. */
  chain: string[];
}

export interface EndpointTrace {
  endpoint: string;
  handler: string;
  /** `false` when the handler method was not found in the files read. */
  found: boolean;
  calls: ReachedCall[];
  /** Methods visited, the deepest call chain, and whether a limit cut the trace. */
  steps: number;
  depth: number;
  truncated: boolean;
  /** Invocations whose receiver type the trace could not tell, and those on a type outside the repo (a library). */
  unresolved: number;
  external: number;
}

interface IndexedType {
  fqn: string;
  file: CallFile;
  type: CallType;
}

interface MethodRef {
  owner: IndexedType;
  method: CallMethod;
}

/** The repo's types by qualified and simple name, with each type's direct subtypes. */
export class CallIndex {
  private readonly byFqn = new Map<string, IndexedType[]>();
  private readonly bySimple = new Map<string, IndexedType[]>();
  private readonly subtypes = new Map<IndexedType, IndexedType[]>();
  private readonly supertypeCache = new Map<IndexedType, IndexedType[]>();

  constructor(files: readonly CallFile[]) {
    for (const file of files)
      for (const type of file.types) {
        const indexed = { fqn: file.pkg ? `${file.pkg}.${type.name}` : type.name, file, type };
        push(this.byFqn, indexed.fqn, indexed);
        push(this.bySimple, type.name, indexed);
      }
    for (const list of this.byFqn.values()) for (const t of list) for (const parent of this.supertypes(t)) push(this.subtypes, parent, t);
  }

  /** A simple type name as seen from `from`: imports, the same file and package, wildcard imports, then by simple name. */
  resolve(name: string, from: CallFile): IndexedType | undefined {
    const candidates = [from.imports.get(name), from.pkg ? `${from.pkg}.${name}` : name, ...from.wildcards.map((w) => `${w}.${name}`)];
    for (const fqn of candidates) {
      const found = fqn === undefined ? undefined : this.closest(this.byFqn.get(fqn), from);
      if (found) return found;
    }
    // An import of a type outside the repo: not ours, even if the repo has a type of the same simple name.
    if (from.imports.has(name)) return undefined;
    return this.closest(this.bySimple.get(name), from);
  }

  /** Of types with one name, the one in the same module; the same class copied into several services is common. */
  private closest(list: IndexedType[] | undefined, from: CallFile): IndexedType | undefined {
    if (!list || list.length === 0) return undefined;
    const module = moduleOf(from.path);
    return list.find((t) => moduleOf(t.file.path) === module) ?? list[0];
  }

  supertypes(t: IndexedType): IndexedType[] {
    const cached = this.supertypeCache.get(t);
    if (cached) return cached;
    const list = t.type.supertypes.flatMap((s) => this.resolve(s, t.file) ?? []).filter((s) => s !== t);
    this.supertypeCache.set(t, list);
    return list;
  }

  /** Every subtype of `t` in the repo, transitively. */
  allSubtypes(t: IndexedType): IndexedType[] {
    const out: IndexedType[] = [];
    const queue = [t];
    const seen = new Set([t]);
    for (let next = queue.shift(); next; next = queue.shift())
      for (const sub of this.subtypes.get(next) ?? [])
        if (!seen.has(sub)) {
          seen.add(sub);
          out.push(sub);
          queue.push(sub);
        }
    return out;
  }

  *allTypes(): Generator<IndexedType> {
    for (const list of this.byFqn.values()) yield* list;
  }

  typeNamed(name: string, path: string): IndexedType | undefined {
    const list = this.bySimple.get(name) ?? [];
    return list.find((t) => t.file.path === path) ?? list.find((t) => moduleOf(t.file.path) === moduleOf(path)) ?? list[0];
  }

  /** Methods named `name` declared in `t` or inherited from its supertypes (the nearest declaration wins). */
  lookup(t: IndexedType, name: string, arity: number): MethodRef[] {
    const seen = new Set<IndexedType>();
    const queue = [t];
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const own = matching(next.type.methods, name, arity);
      if (own.length > 0) return own.map((method) => ({ owner: next, method }));
      queue.push(...this.supertypes(next));
    }
    return [];
  }
}

function matching(methods: readonly CallMethod[], name: string, arity: number): CallMethod[] {
  const named = methods.filter((m) => m.name === name);
  const exact = named.filter((m) => arity < 0 || m.arity < 0 || m.arity === arity);
  return exact.length > 0 ? exact : named;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** HTTP calls by file, for the imperative clients (a call inside a method body) and the declarative ones (an interface method). */
interface CallSites {
  byPath: Map<string, { client: ConsumedHttp; call: HttpCall }[]>;
  /** Declarative clients by the path and name of their interface. */
  interfaces: Map<string, ConsumedHttp>;
}

function callSites(clients: readonly ConsumedHttp[]): CallSites {
  const byPath = new Map<string, { client: ConsumedHttp; call: HttpCall }[]>();
  const interfaces = new Map<string, ConsumedHttp>();
  for (const client of clients) {
    for (const call of client.calls) push(byPath, call.evidence.path, { client, call });
    if (client.via === "feign" || client.via === "http-interface") interfaces.set(`${client.evidence.path}#${client.name}`, client);
  }
  return { byPath, interfaces };
}

export function traceEndpoints(
  endpoints: readonly ProvidedEndpoint[],
  clients: readonly ConsumedHttp[],
  index: CallIndex,
  limits: TraceLimits = { maxDepth: MAX_DEPTH, maxSteps: MAX_STEPS },
): EndpointTrace[] {
  const sites = callSites(clients);
  return endpoints.map((endpoint) => traceOne(endpoint, sites, index, limits));
}

function traceOne(endpoint: ProvidedEndpoint, sites: CallSites, index: CallIndex, limits: TraceLimits): EndpointTrace {
  const [typeName = "", methodName = ""] = endpoint.handler?.split(".") ?? [];
  const label = `${endpoint.method ?? "*"} ${endpoint.path}`;
  const result: EndpointTrace = {
    endpoint: label,
    handler: endpoint.handler ?? "",
    found: false,
    calls: [],
    steps: 0,
    depth: 0,
    truncated: false,
    unresolved: 0,
    external: 0,
  };
  const controller = index.typeNamed(typeName, endpoint.evidence.path);
  const roots = controller ? index.lookup(controller, methodName, -1) : [];
  result.found = roots.length > 0;
  const seen = new Set<CallMethod>();
  const reached = new Map<string, ReachedCall>();
  let frontier = roots.map((r) => ({ ...r, chain: [`${r.owner.type.name}.${r.method.name}`] }));
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= limits.maxDepth) {
      result.truncated = true;
      break;
    }
    const next: typeof frontier = [];
    for (const step of frontier) {
      if (seen.has(step.method)) continue;
      if (result.steps >= limits.maxSteps) {
        result.truncated = true;
        break;
      }
      seen.add(step.method);
      result.steps++;
      result.depth = Math.max(result.depth, depth);
      collectCalls(step, step.chain, sites, reached);
      for (const inv of step.method.invocations) {
        const targets = targetsOf(inv, step, index, result);
        for (const t of targets)
          if (!seen.has(t.method)) next.push({ ...t, chain: [...step.chain, `${t.owner.type.name}.${t.method.name}`] });
      }
    }
    frontier = next;
  }
  result.calls = [...reached.values()];
  return result;
}

/** HTTP calls in the method's body (imperative clients) or on the method itself (a declarative client interface). */
function collectCalls(step: MethodRef, chain: string[], sites: CallSites, reached: Map<string, ReachedCall>): void {
  const path = step.owner.file.path;
  const declarative = sites.interfaces.get(`${path}#${step.owner.type.name}`);
  for (const { client, call } of sites.byPath.get(path) ?? []) {
    const line = call.evidence.line ?? -1;
    if (line < step.method.startLine || line > step.method.endLine) continue;
    if (declarative && client !== declarative) continue;
    const key = `${client.name}|${call.method}|${call.path}|${call.evidence.path}:${call.evidence.line}`;
    if (!reached.has(key)) reached.set(key, { client: client.name, via: client.via, app: client.app, url: client.url, call, chain });
  }
}

function targetsOf(inv: Invocation, from: MethodRef, index: CallIndex, result: EndpointTrace): MethodRef[] {
  const receiver = receiverType(inv.receiver, from, index);
  if (receiver.kind === "unknown") {
    result.unresolved++;
    return [];
  }
  if (receiver.kind === "external") {
    result.external++;
    return [];
  }
  const declared = index.lookup(receiver.type, inv.name, inv.arity);
  // Dynamic dispatch: an interface or an abstract method reaches the implementations in the repo; `super.m()` does not.
  if (inv.receiver.kind === "super") return declared;
  const overriding = index
    .allSubtypes(receiver.type)
    .flatMap((sub) => matching(sub.type.methods, inv.name, inv.arity).map((method) => ({ owner: sub, method })));
  return [...declared, ...overriding];
}

type ResolvedType = { kind: "type"; type: IndexedType } | { kind: "external" } | { kind: "unknown" };

function receiverType(receiver: Receiver, from: MethodRef, index: CallIndex): ResolvedType {
  const named = (name: string | null | undefined): ResolvedType => {
    if (!name) return { kind: "unknown" };
    const type = index.resolve(name, from.owner.file);
    return type ? { kind: "type", type } : { kind: "external" };
  };
  switch (receiver.kind) {
    case "none":
    case "this":
      return { kind: "type", type: from.owner };
    case "super": {
      const [parent] = index.supertypes(from.owner);
      return parent ? { kind: "type", type: parent } : { kind: "external" };
    }
    case "new":
      return named(receiver.type);
    case "name": {
      const local = from.method.locals.get(receiver.name);
      if (local) return named(local);
      const field = fieldType(from.owner, receiver.name, index);
      if (field) return typeIn(field.type, field.owner, index);
      // An upper-case name without a variable is a type: a static call (`OrderMapper.toDto(…)`).
      if (/^[A-Z]/.test(receiver.name)) return named(receiver.name);
      return { kind: "unknown" };
    }
    case "field": {
      if (receiver.of.kind === "this") {
        const field = fieldType(from.owner, receiver.name, index);
        return field ? typeIn(field.type, field.owner, index) : { kind: "unknown" };
      }
      const of = receiverType(receiver.of, from, index);
      if (of.kind !== "type") return of;
      const field = fieldType(of.type, receiver.name, index);
      return field ? typeIn(field.type, field.owner, index) : { kind: "unknown" };
    }
    case "call": {
      const of = receiverType(receiver.of, from, index);
      if (of.kind !== "type") return of;
      const [method] = index.lookup(of.type, receiver.name, receiver.arity);
      if (!method?.method.returns) return method ? { kind: "unknown" } : { kind: "external" };
      return typeIn(method.method.returns, method.owner, index);
    }
    case "unknown":
      return { kind: "unknown" };
  }
}

/** A field's type in `t` or its supertypes, with the type that declares it (its imports resolve the name). */
function fieldType(t: IndexedType, name: string, index: CallIndex): { type: string; owner: IndexedType } | undefined {
  const seen = new Set<IndexedType>();
  const queue = [t];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    const type = next.type.fields.get(name);
    if (type) return { type, owner: next };
    queue.push(...index.supertypes(next));
  }
  return undefined;
}

/** A type name as written in the file of `owner`. */
function typeIn(name: string, owner: IndexedType, index: CallIndex): ResolvedType {
  const type = index.resolve(name, owner.file);
  return type ? { kind: "type", type } : { kind: "external" };
}

/**
 * The same question answered for all endpoints at once: the repo's call graph is built once, its strongly connected
 * components are collapsed, and each component's reachable HTTP calls are computed once (linear in the graph, no depth or
 * step limit). A call on a type with more than `maxDispatch` implementations is a hub (a generic DAO, a visitor) and is
 * not followed: it would make every endpoint reach everything.
 */
export interface ClosureTrace {
  endpoint: string;
  handler: string;
  found: boolean;
  calls: { client: string; via: ConsumedHttp["via"]; app: string | null; url: string | null; call: HttpCall }[];
}

export interface ClosureStats {
  methods: number;
  edges: number;
  components: number;
  hubsSkipped: number;
  unresolved: number;
  external: number;
}

export function traceClosure(
  endpoints: readonly ProvidedEndpoint[],
  clients: readonly ConsumedHttp[],
  index: CallIndex,
  maxDispatch: number,
): { traces: ClosureTrace[]; stats: ClosureStats } {
  const sites = callSites(clients);
  const ids = new Map<CallMethod, number>();
  const refs: MethodRef[] = [];
  for (const t of index.allTypes())
    for (const method of t.type.methods) {
      ids.set(method, refs.length);
      refs.push({ owner: t, method });
    }
  const counter: EndpointTrace = {
    endpoint: "",
    handler: "",
    found: false,
    calls: [],
    steps: 0,
    depth: 0,
    truncated: false,
    unresolved: 0,
    external: 0,
  };
  let hubsSkipped = 0;
  let edgeCount = 0;
  const edges: number[][] = refs.map((ref) => {
    const out = new Set<number>();
    for (const inv of ref.method.invocations) {
      const targets = targetsOf(inv, ref, index, counter);
      if (targets.length > maxDispatch) {
        hubsSkipped++;
        continue;
      }
      for (const t of targets) {
        const id = ids.get(t.method);
        if (id !== undefined) out.add(id);
      }
    }
    edgeCount += out.size;
    return [...out];
  });
  // Call sites each method holds directly.
  const siteList: { client: ConsumedHttp; call: HttpCall }[] = [];
  const siteKey = new Map<HttpCall, number>();
  const own: number[][] = refs.map((ref) => {
    const reached = new Map<string, ReachedCall>();
    collectCalls(ref, [], sites, reached);
    return [...reached.values()].map((r) => {
      let id = siteKey.get(r.call);
      if (id === undefined) {
        id = siteList.length;
        siteKey.set(r.call, id);
        const client = clients.find((c) => c.name === r.client && c.calls.includes(r.call));
        if (!client) throw new Error(`call site without its client: ${r.client}`);
        siteList.push({ client, call: r.call });
      }
      return id;
    });
  });
  const { component, order } = tarjan(edges);
  // Components come out of Tarjan in reverse topological order: every successor component is finished first.
  const reach = new Map<number, Set<number>>();
  for (const members of order) {
    const set = new Set<number>();
    const comp = component[members[0] ?? 0] ?? 0;
    for (const m of members) {
      for (const s of own[m] ?? []) set.add(s);
      for (const next of edges[m] ?? []) {
        const c = component[next] ?? 0;
        if (c !== comp) for (const s of reach.get(c) ?? []) set.add(s);
      }
    }
    reach.set(comp, set);
  }
  const traces = endpoints.map((endpoint) => {
    const [typeName = "", methodName = ""] = endpoint.handler?.split(".") ?? [];
    const controller = index.typeNamed(typeName, endpoint.evidence.path);
    const roots = controller ? index.lookup(controller, methodName, -1) : [];
    const found = new Set<number>();
    for (const r of roots) {
      const id = ids.get(r.method);
      if (id !== undefined) for (const s of reach.get(component[id] ?? -1) ?? []) found.add(s);
    }
    return {
      endpoint: `${endpoint.method ?? "*"} ${endpoint.path}`,
      handler: endpoint.handler ?? "",
      found: roots.length > 0,
      calls: [...found].flatMap((s) => {
        const site = siteList[s];
        return site
          ? [{ client: site.client.name, via: site.client.via, app: site.client.app, url: site.client.url, call: site.call }]
          : [];
      }),
    };
  });
  return {
    traces,
    stats: {
      methods: refs.length,
      edges: edgeCount,
      components: order.length,
      hubsSkipped,
      unresolved: counter.unresolved,
      external: counter.external,
    },
  };
}

/** Iterative Tarjan: the component of every node and the components' members in reverse topological order. */
function tarjan(edges: readonly number[][]): { component: number[]; order: number[][] } {
  const n = edges.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const component = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  const order: number[][] = [];
  let counter = 0;
  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    const work: [number, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1] as [number, number];
      const [v, i] = frame;
      if (i === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = true;
      }
      const next = edges[v]?.[i];
      if (next !== undefined) {
        frame[1] = i + 1;
        if (index[next] === -1) work.push([next, 0]);
        else if (onStack[next]) low[v] = Math.min(low[v] ?? 0, index[next] ?? 0);
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]] ?? 0, low[v] ?? 0);
      if (low[v] === index[v]) {
        const members: number[] = [];
        let w: number | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack[w] = false;
          component[w] = order.length;
          members.push(w);
        } while (w !== v);
        order.push(members);
      }
    }
  }
  return { component, order };
}
