import type { Node } from "web-tree-sitter";
import { linesOf, simpleName } from "./contract-syntax.ts";

/**
 * Who calls whom in a Java file, read from its syntax tree for the endpoint reach (§4.6, ADR-82): types with their
 * supertypes and fields, methods with their parameters, local variables and the calls in their bodies. Plain values
 * without nodes, because the tree is freed after reading (`syntax-tree.ts`), and without the file's path, so one read
 * serves every file with the same content (`call-files.ts`). Types are simple names without type arguments;
 * `call-graph.ts` resolves them through the file's imports and package.
 */
export interface JavaCalls {
  /** The package (`com.example.orders`); `""` in the default package. */
  pkg: string;
  /** Single-type imports by simple name (`Foo` → `com.example.Foo`), without static imports. */
  imports: ReadonlyMap<string, string>;
  /** The packages of wildcard imports (`com.example.*` → `com.example`). */
  wildcards: readonly string[];
  /** Every type declared in the file, nested ones too, each with only its own members. */
  types: readonly CallType[];
}

export interface CallType {
  name: string;
  /** The name within the file: `Outer.Inner` for a nested type, which is how an import names it. */
  qualified: string;
  /** Simple names of the superclass and the interfaces (an interface's `extends` too). */
  supertypes: readonly string[];
  /** Fields and record components by name, with their simple type name. */
  fields: ReadonlyMap<string, string>;
  methods: readonly CallMethod[];
}

export interface CallMethod {
  /** The method name; a constructor has none of its own and is not followed (Spring creates beans). */
  name: string;
  /** The number of parameters; `-1` for varargs, which match any number of arguments. */
  arity: number;
  /** The simple return type name; `null` for `void`, a primitive or an array. */
  returns: string | null;
  /** Lines (from 1) from the first annotation to the end of the body: a client call on a line within them is in the method. */
  startLine: number;
  endLine: number;
  /** Parameters and local variables by name: a declared type, or for `var` the expression it is set to. */
  locals: ReadonlyMap<string, Local>;
  calls: readonly Invocation[];
}

type Local = { kind: "type"; name: string } | { kind: "expression"; value: Receiver };

/** What a call is made on, as far as the syntax tells without types. */
export type Receiver =
  | { kind: "none" }
  | { kind: "this" }
  | { kind: "super" }
  | { kind: "name"; name: string }
  | { kind: "field"; of: Receiver; name: string }
  | { kind: "call"; of: Receiver; name: string; arity: number }
  | { kind: "type"; name: string }
  | { kind: "unknown" };

export interface Invocation {
  receiver: Receiver;
  name: string;
  /** The number of arguments; `-1` for a method reference (`foo::bar`), whose arity the syntax does not give. */
  arity: number;
}

const TYPE_NODES = ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"];
/** Receiver expressions nested deeper than this (a long fluent chain) are `unknown`: they reach no code of the repo. */
const MAX_RECEIVER_DEPTH = 8;

export function readJavaCalls(root: Node): JavaCalls {
  const imports = new Map<string, string>();
  const wildcards: string[] = [];
  for (const decl of root.namedChildren.filter((c) => c.type === "import_declaration")) {
    const name = decl.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
    if (!name || decl.children.some((c) => c.type === "static")) continue;
    if (decl.namedChildren.some((c) => c.type === "asterisk")) wildcards.push(name);
    else imports.set(simpleName(name), name);
  }
  const pkg = root.namedChildren.find((c) => c.type === "package_declaration")?.namedChildren[0]?.text ?? "";
  return { pkg, imports, wildcards, types: root.descendantsOfType(TYPE_NODES).flatMap(callType) };
}

function callType(node: Node): CallType[] {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return [];
  // Only the type's own members: a nested type is read as a type of its own.
  const members = membersOf(body);
  const methods = members.filter((m) => m.type === "method_declaration").flatMap(callMethod);
  return [{ name, qualified: qualifiedName(node, name), supertypes: supertypesOf(node), fields: fieldsOf(node, members), methods }];
}

/** The members of a type's body; an enum has them after its constants, in `enum_body_declarations`. */
function membersOf(body: Node): Node[] {
  return body.namedChildren.flatMap((c) => (c.type === "enum_body_declarations" ? c.namedChildren : [c]));
}

function qualifiedName(node: Node, name: string): string {
  const outer: string[] = [];
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    const outerName = TYPE_NODES.includes(parent.type) ? parent.childForFieldName("name")?.text : undefined;
    if (outerName) outer.unshift(outerName);
  }
  return [...outer, name].join(".");
}

function fieldsOf(node: Node, members: readonly Node[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const member of members.filter((m) => m.type === "field_declaration" || m.type === "constant_declaration")) {
    const type = typeName(member.childForFieldName("type"));
    for (const declarator of member.childrenForFieldName("declarator")) {
      const field = declarator.childForFieldName("name")?.text;
      if (field && type) fields.set(field, type);
    }
  }
  // Record components are fields too.
  for (const component of node.childForFieldName("parameters")?.namedChildren ?? []) {
    const field = component.childForFieldName("name")?.text;
    const type = typeName(component.childForFieldName("type"));
    if (field && type) fields.set(field, type);
  }
  return fields;
}

/** The outer types a declaration extends or implements: `I<X>` gives `I`, not `X`. */
function supertypesOf(node: Node): string[] {
  const lists = [
    node.childForFieldName("superclass"),
    node.childForFieldName("interfaces"),
    node.namedChildren.find((c) => c.type === "extends_interfaces"),
  ];
  return lists.flatMap((list) => {
    const types = list?.namedChildren.find((c) => c.type === "type_list")?.namedChildren ?? list?.namedChildren ?? [];
    return types.flatMap((t) => typeName(t) ?? []);
  });
}

function callMethod(node: Node): CallMethod[] {
  const name = node.childForFieldName("name")?.text;
  if (!name) return [];
  const params = node.childForFieldName("parameters")?.namedChildren ?? [];
  const locals = new Map<string, Local>();
  for (const param of params) {
    const declarator = param.type === "spread_parameter" ? param.namedChildren.find((c) => c.type === "variable_declarator") : param;
    const type = typeName(param.childForFieldName("type") ?? param.namedChildren.find((c) => typeName(c) !== null));
    const local = declarator?.childForFieldName("name")?.text;
    if (local && type) locals.set(local, { kind: "type", name: type });
  }
  const body = node.childForFieldName("body");
  // `formal_parameter` in the body is a lambda's typed parameter; one without a type is not read.
  for (const decl of body?.descendantsOfType([
    "local_variable_declaration",
    "enhanced_for_statement",
    "catch_formal_parameter",
    "formal_parameter",
  ]) ?? [])
    readLocals(decl, locals);
  return [
    {
      name,
      arity: params.some((p) => p.type === "spread_parameter") ? -1 : params.filter((p) => p.type === "formal_parameter").length,
      returns: typeName(node.childForFieldName("type")),
      ...linesOf(node),
      locals,
      calls: (body?.descendantsOfType(["method_invocation", "method_reference"]) ?? []).flatMap(invocation),
    },
  ];
}

/**
 * Local variables of a declaration, a `for (T x : …)`, a `catch (T e)` (the first type of `A | B`) or a lambda's
 * `(T x) ->`; `var x = e` keeps the expression `e`.
 */
function readLocals(decl: Node, locals: Map<string, Local>): void {
  const typeNode =
    decl.type === "catch_formal_parameter"
      ? decl.namedChildren.find((c) => c.type === "catch_type")?.namedChildren[0]
      : decl.childForFieldName("type");
  const declared = typeName(typeNode);
  const declarators = decl.type === "local_variable_declaration" ? decl.childrenForFieldName("declarator") : [decl];
  for (const declarator of declarators) {
    const name = declarator.childForFieldName("name")?.text;
    const value = declarator.childForFieldName("value");
    if (!name) continue;
    if (declared !== null && declared !== "var") locals.set(name, { kind: "type", name: declared });
    else if (value && decl.type === "local_variable_declaration") locals.set(name, { kind: "expression", value: receiverOf(value, 0) });
  }
}

function invocation(node: Node): Invocation[] {
  if (node.type === "method_reference") {
    const [target, method] = node.namedChildren;
    if (!target || method?.type !== "identifier") return [];
    return [{ receiver: receiverOf(target, 0), name: method.text, arity: -1 }];
  }
  const name = node.childForFieldName("name")?.text;
  if (!name) return [];
  const object = node.childForFieldName("object");
  return [{ receiver: object ? receiverOf(object, 0) : { kind: "none" }, name, arity: arityOf(node) }];
}

function arityOf(call: Node): number {
  return call.childForFieldName("arguments")?.namedChildren.filter((c) => !c.type.includes("comment")).length ?? 0;
}

function receiverOf(node: Node, depth: number): Receiver {
  if (depth > MAX_RECEIVER_DEPTH) return { kind: "unknown" };
  switch (node.type) {
    case "this":
      return { kind: "this" };
    case "super":
      return { kind: "super" };
    case "identifier":
    case "type_identifier":
      return { kind: "name", name: node.text };
    case "field_access":
      return fieldReceiver(node, depth);
    case "method_invocation":
      return callReceiver(node, depth);
    case "object_creation_expression":
    case "cast_expression":
      return typeReceiver(typeName(node.childForFieldName("type")));
    case "parenthesized_expression": {
      const inner = node.namedChildren.at(-1);
      return inner ? receiverOf(inner, depth + 1) : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

function fieldReceiver(node: Node, depth: number): Receiver {
  const object = node.childForFieldName("object");
  const field = node.childForFieldName("field")?.text;
  return object && field ? { kind: "field", of: receiverOf(object, depth + 1), name: field } : { kind: "unknown" };
}

function callReceiver(node: Node, depth: number): Receiver {
  const name = node.childForFieldName("name")?.text;
  const object = node.childForFieldName("object");
  if (!name) return { kind: "unknown" };
  return { kind: "call", of: object ? receiverOf(object, depth + 1) : { kind: "none" }, name, arity: arityOf(node) };
}

function typeReceiver(name: string | null): Receiver {
  return name ? { kind: "type", name } : { kind: "unknown" };
}

/** The simple name of a type without type arguments; `null` for `void`, a primitive and an array. */
function typeName(node: Node | null | undefined): string | null {
  switch (node?.type) {
    case "type_identifier":
      return node.text;
    case "scoped_type_identifier":
      return simpleName(node.text.replace(/<.*$/s, ""));
    case "generic_type":
      return typeName(node.namedChildren[0]);
    default:
      return null;
  }
}
