import { type CallFile, CallTypes, type MethodOf, matching, type RepoType } from "./call-types.ts";
import type { CallMethod, Invocation, Receiver } from "./java-calls.ts";

/**
 * The repo's call graph for the endpoint reach (§4.6, ADR-82): a node per Java method, an edge per method a call in its
 * body can run. Static and without compiling: a receiver's type comes from a local variable, a parameter, a field or a
 * method's return type in the repo. A call on an interface or an abstract type runs each of its implementations in the repo
 * (the graph answers "may call"), except a type with more than `MAX_DISPATCH` of them (a generic DAO, a visitor),
 * which would make every endpoint reach everything: then only the method the type itself has is followed. A call on a
 * library type ends the path.
 */

/** The most implementations a call on one type is followed into. */
export const MAX_DISPATCH = 8;
/** `var` chains resolved through further `var`s at most this deep: `var a = b.c()` where `b` is a `var` too. */
const MAX_LOCAL_DEPTH = 4;

export interface CallGraph {
  methods: MethodOf[];
  /** By method index, the indexes of the methods its calls can run. */
  edges: number[][];
  index: ReadonlyMap<CallMethod, number>;
  types: CallTypes;
}

export function buildCallGraph(files: readonly CallFile[]): CallGraph {
  const types = new CallTypes(files);
  const methods: MethodOf[] = [];
  const index = new Map<CallMethod, number>();
  for (const owner of types.all())
    for (const method of owner.type.methods) {
      index.set(method, methods.length);
      methods.push({ owner, method });
    }
  const edges = methods.map((from) => {
    const to = new Set<number>();
    for (const call of from.method.calls) for (const target of targetsOf(call, from, types)) to.add(index.get(target.method) ?? -1);
    to.delete(-1);
    return [...to];
  });
  return { methods, edges, index, types };
}

function targetsOf(call: Invocation, from: MethodOf, types: CallTypes): MethodOf[] {
  const receiver = receiverType(call.receiver, from, types, 0);
  if (!receiver) return [];
  const declared = types.declared(receiver, call.name, call.arity);
  // `super.m()` runs exactly the parent's method.
  if (call.receiver.kind === "super") return declared;
  const implementations = types.subtypes(receiver);
  // The method the type itself declares or inherits still runs, so a base class with many subclasses keeps its own calls.
  if (implementations.length > MAX_DISPATCH) return declared;
  const overriding = implementations.flatMap((sub) =>
    matching(sub.type.methods, call.name, call.arity, true).map((method) => ({ owner: sub, method })),
  );
  return [...declared, ...overriding];
}

/** The repo type an expression has; `undefined` when the syntax does not tell or the type is not from the repo. */
function receiverType(receiver: Receiver, from: MethodOf, types: CallTypes, depth: number): RepoType | undefined {
  switch (receiver.kind) {
    case "none":
    case "this":
      return from.owner;
    case "super":
      return types.supertypes(from.owner)[0];
    case "type":
      return types.resolve(receiver.name, from.owner.file);
    case "name":
      return nameType(receiver.name, from, types, depth);
    case "field": {
      const of = receiverType(receiver.of, from, types, depth);
      return of && fieldType(of, receiver.name, types);
    }
    case "call": {
      const of = receiverType(receiver.of, from, types, depth);
      const [method] = of ? types.declared(of, receiver.name, receiver.arity) : [];
      return method?.method.returns ? types.resolve(method.method.returns, method.owner.file) : undefined;
    }
    case "unknown":
      return undefined;
  }
}

/** A name: a local variable or parameter, a field of the class or its supertypes, or a class for a static call. */
function nameType(name: string, from: MethodOf, types: CallTypes, depth: number): RepoType | undefined {
  const local = from.method.locals.get(name);
  if (local?.kind === "type") return types.resolve(local.name, from.owner.file);
  if (local?.kind === "expression") return depth < MAX_LOCAL_DEPTH ? receiverType(local.value, from, types, depth + 1) : undefined;
  const field = fieldType(from.owner, name, types);
  if (field) return field;
  // Java names classes with a capital letter, variables without: `OrderMapper.toDto(…)` is a static call.
  return /^[A-Z]/.test(name) ? types.resolve(name, from.owner.file) : undefined;
}

function fieldType(of: RepoType, name: string, types: CallTypes): RepoType | undefined {
  const field = types.field(of, name);
  return field && types.resolve(field.type, field.owner.file);
}
