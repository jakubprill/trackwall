import type { CallMethod, CallType, JavaCalls } from "./java-calls.ts";
import { moduleOf } from "./spring-config.ts";

/**
 * The repo's Java types for the call graph (§4.6, ADR-82): a simple type name as one file sees it (its imports, its
 * package, its wildcard imports, then by simple name in the same module), the supertypes and subtypes of a type, and
 * the methods a call on a type can run.
 */

/** A Java file read for the endpoint reach: its path and what `java-calls.ts` read from it. */
export interface CallFile {
  path: string;
  calls: JavaCalls;
}

export interface RepoType {
  /** The qualified name (`com.example.orders.OrderService`). */
  fqn: string;
  file: CallFile;
  type: CallType;
}

export interface MethodOf {
  owner: RepoType;
  method: CallMethod;
}

export class CallTypes {
  private readonly byFqn = new Map<string, RepoType[]>();
  private readonly bySimple = new Map<string, RepoType[]>();
  private readonly direct = new Map<RepoType, RepoType[]>();
  private readonly subtypeCache = new Map<RepoType, RepoType[]>();
  private readonly supertypeCache = new Map<RepoType, RepoType[]>();

  constructor(files: readonly CallFile[]) {
    for (const file of files)
      for (const type of file.calls.types) {
        const fqn = file.calls.pkg ? `${file.calls.pkg}.${type.qualified}` : type.qualified;
        const repoType = { fqn, file, type };
        push(this.byFqn, fqn, repoType);
        push(this.bySimple, type.name, repoType);
      }
    for (const t of this.all()) for (const parent of this.supertypes(t)) push(this.direct, parent, t);
  }

  *all(): Generator<RepoType> {
    for (const list of this.byFqn.values()) yield* list;
  }

  /** Type `name` as written in file `from`; `undefined` for a type from outside the repo (a library, the JDK). */
  resolve(name: string, from: CallFile): RepoType | undefined {
    const imported = from.calls.imports.get(name);
    // An import from outside the repo wins over a repo type with the same simple name.
    if (imported !== undefined) return this.closest(this.byFqn.get(imported), from);
    const pkg = from.calls.pkg;
    // A type nested in the asking file, named by its simple name there.
    const nested = from.calls.types.find((t) => t.name === name)?.qualified;
    for (const fqn of [
      ...(nested ? [pkg ? `${pkg}.${nested}` : nested] : []),
      pkg ? `${pkg}.${name}` : name,
      ...from.calls.wildcards.map((w) => `${w}.${name}`),
    ]) {
      const found = this.closest(this.byFqn.get(fqn), from);
      if (found) return found;
    }
    return this.closest(this.bySimple.get(name), from);
  }

  /** A controller's type by its simple name, preferring the file of its endpoint and then the endpoint's module. */
  named(name: string, path: string): RepoType | undefined {
    const list = this.bySimple.get(name) ?? [];
    return list.find((t) => t.file.path === path) ?? this.closest(list, { path });
  }

  /** The same class is often copied into several services of one repo, so the one in the asking file's module wins. */
  private closest(list: readonly RepoType[] | undefined, from: Pick<CallFile, "path">): RepoType | undefined {
    const module = moduleOf(from.path);
    return list?.find((t) => moduleOf(t.file.path) === module) ?? list?.[0];
  }

  supertypes(t: RepoType): RepoType[] {
    const cached = this.supertypeCache.get(t);
    if (cached) return cached;
    const list = t.type.supertypes.flatMap((s) => this.resolve(s, t.file) ?? []).filter((s) => s !== t);
    this.supertypeCache.set(t, list);
    return list;
  }

  /** Every type in the repo that extends or implements `t`, also through other types. */
  subtypes(t: RepoType): RepoType[] {
    const cached = this.subtypeCache.get(t);
    if (cached) return cached;
    const list = [...walk(t, (next) => this.direct.get(next) ?? [])].slice(1);
    this.subtypeCache.set(t, list);
    return list;
  }

  /**
   * The methods named `name` a call on `t` with `arity` arguments runs: the nearest declaration in `t` and its
   * supertypes that takes that many arguments, and only when none does anywhere, the nearest with that name.
   */
  declared(t: RepoType, name: string, arity: number): MethodOf[] {
    const hierarchy = [...walk(t, (type) => this.supertypes(type))];
    for (const strict of [true, false])
      for (const next of hierarchy) {
        const own = matching(next.type.methods, name, arity, strict);
        if (own.length > 0) return own.map((method) => ({ owner: next, method }));
      }
    return [];
  }

  /** The type of field `name` of `t` or of its supertypes, as written in the declaring type's file. */
  field(t: RepoType, name: string): { type: string; owner: RepoType } | undefined {
    for (const next of walk(t, (type) => this.supertypes(type))) {
      const type = next.type.fields.get(name);
      if (type !== undefined) return { type, owner: next };
    }
    return undefined;
  }
}

/**
 * Methods named `name` that take `arity` arguments; unless `strict`, when none does (a type the syntax could not tell
 * apart, an argument count the reading got wrong), all with that name.
 */
export function matching(methods: readonly CallMethod[], name: string, arity: number, strict: boolean): CallMethod[] {
  const named = methods.filter((m) => m.name === name);
  const exact = named.filter((m) => arity < 0 || m.arity < 0 || m.arity === arity);
  return exact.length > 0 || strict ? exact : named;
}

/** `start` and every type reachable from it through `next`, each once, nearest first. */
function* walk(start: RepoType, next: (t: RepoType) => readonly RepoType[]): Generator<RepoType> {
  const seen = new Set([start]);
  const queue = [start];
  // An index instead of `shift()`: a hierarchy with thousands of types would make the walk quadratic.
  for (let i = 0, t = queue[0]; t !== undefined; t = queue[++i]) {
    yield t;
    for (const n of next(t))
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  }
}

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
