import type { Node } from "web-tree-sitter";
import { lineOf, simpleName } from "./contract-syntax.ts";

/**
 * SPIKE (ADR-82 candidate, issue #120): what a Java file says about who calls whom, read from the syntax tree for the
 * endpoint trace (`endpoint-trace.ts`). Plain values without nodes, because the tree is freed after reading
 * (`syntax-tree.ts`). Types are simple names without type arguments; the trace resolves them through the imports.
 */
export interface CallFile {
  path: string;
  /** The package (`com.example.orders`); `""` in the default package. */
  pkg: string;
  /** Single-type imports by simple name (`Foo` → `com.example.Foo`) and the packages of wildcard imports. */
  imports: Map<string, string>;
  wildcards: string[];
  types: CallType[];
}

export interface CallType {
  name: string;
  kind: "class" | "interface" | "enum" | "record";
  abstract: boolean;
  /** Simple names of the superclass and the interfaces. */
  supertypes: string[];
  /** Fields (and record components) by name, with their simple type name. */
  fields: Map<string, string>;
  methods: CallMethod[];
}

export interface CallMethod {
  name: string;
  /** `-1` for varargs: any number of arguments matches. */
  arity: number;
  /** The simple return type name; `null` for `void`. */
  returns: string | null;
  /** Lines (from 1) from the first annotation to the end of the body. */
  startLine: number;
  endLine: number;
  hasBody: boolean;
  /** Parameters and local variables by name with their simple type name (`var` with `new T(…)` gives `T`). */
  locals: Map<string, string>;
  invocations: Invocation[];
}

/** What a call is made on, as far as the syntax tells without types. */
export type Receiver =
  | { kind: "none" }
  | { kind: "this" }
  | { kind: "super" }
  | { kind: "name"; name: string }
  | { kind: "field"; of: Receiver; name: string }
  | { kind: "call"; of: Receiver; name: string; arity: number }
  | { kind: "new"; type: string }
  | { kind: "unknown" };

export interface Invocation {
  receiver: Receiver;
  name: string;
  /** `-1` for a method reference (`foo::bar`), whose arity the syntax does not give. */
  arity: number;
  line: number;
}

const TYPE_NODES = ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"];

export function readJavaCalls(path: string, root: Node): CallFile {
  const pkg = root.namedChildren.find((c) => c.type === "package_declaration")?.namedChildren[0]?.text ?? "";
  const imports = new Map<string, string>();
  const wildcards: string[] = [];
  for (const decl of root.namedChildren.filter((c) => c.type === "import_declaration")) {
    if (decl.children.some((c) => c.type === "static")) continue;
    const name = decl.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
    if (!name) continue;
    if (decl.namedChildren.some((c) => c.type === "asterisk")) wildcards.push(name);
    else imports.set(simpleName(name), name);
  }
  return { path, pkg, imports, wildcards, types: root.descendantsOfType(TYPE_NODES).flatMap(callType) };
}

function callType(node: Node): CallType[] {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return [];
  const kind = node.type.replace("_declaration", "") as CallType["kind"];
  const fields = new Map<string, string>();
  for (const member of body.namedChildren.filter((m) => m.type === "field_declaration" || m.type === "constant_declaration")) {
    const type = typeName(member.childForFieldName("type"));
    for (const d of member.childrenForFieldName("declarator")) {
      const field = d.childForFieldName("name")?.text;
      if (field && type) fields.set(field, type);
    }
  }
  for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
    const field = p.childForFieldName("name")?.text;
    const type = typeName(p.childForFieldName("type"));
    if (field && type) fields.set(field, type);
  }
  // Only the type's own members: a nested type is read as its own type, and its methods are not this type's.
  const methods = body.namedChildren
    .filter((m) => m.type === "method_declaration" || m.type === "constructor_declaration")
    .map((m) => callMethod(m, name));
  return [{ name, kind, abstract: hasModifier(node, "abstract"), supertypes: supertypesOf(node), fields, methods }];
}

function supertypesOf(node: Node): string[] {
  const names: string[] = [];
  const superclass = node.childForFieldName("superclass");
  const interfaces = node.childForFieldName("interfaces") ?? node.namedChildren.find((c) => c.type === "extends_interfaces");
  for (const list of [superclass, interfaces]) {
    for (const t of list?.descendantsOfType(["type_identifier", "scoped_type_identifier", "generic_type"]) ?? []) {
      // Only the outer types: `I<X>` gives `I`, not `X`.
      if (t.parent?.type === "type_arguments" || t.parent?.parent?.type === "type_arguments") continue;
      if (t.parent?.type === "generic_type" || t.parent?.type === "scoped_type_identifier") continue;
      const name = typeName(t);
      if (name) names.push(name);
    }
  }
  return names;
}

function callMethod(node: Node, owner: string): CallMethod {
  const params = node.childForFieldName("parameters")?.namedChildren ?? [];
  const locals = new Map<string, string>();
  for (const p of params) {
    const name =
      p.childForFieldName("name")?.text ?? p.namedChildren.find((c) => c.type === "variable_declarator")?.childForFieldName("name")?.text;
    const type = typeName(
      p.childForFieldName("type") ?? p.namedChildren.find((c) => c.type.endsWith("type") || c.type === "type_identifier") ?? null,
    );
    if (name && type) locals.set(name, type);
  }
  const body = node.childForFieldName("body");
  for (const decl of body?.descendantsOfType(["local_variable_declaration", "enhanced_for_statement", "catch_formal_parameter"]) ?? []) {
    readLocal(decl, locals);
  }
  const invocations = (body?.descendantsOfType(["method_invocation", "method_reference"]) ?? []).flatMap(invocation);
  const name = node.type === "constructor_declaration" ? `<init>${owner}` : (node.childForFieldName("name")?.text ?? "");
  return {
    name,
    arity: params.some((p) => p.type === "spread_parameter") ? -1 : params.filter((p) => p.type === "formal_parameter").length,
    returns: node.type === "constructor_declaration" ? owner : typeName(node.childForFieldName("type")),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    hasBody: body !== null,
    locals,
    invocations,
  };
}

function readLocal(decl: Node, locals: Map<string, string>): void {
  const declared = typeName(decl.childForFieldName("type"));
  if (decl.type === "enhanced_for_statement" || decl.type === "catch_formal_parameter") {
    const name = decl.childForFieldName("name")?.text;
    if (name && declared && declared !== "var") locals.set(name, declared);
    return;
  }
  for (const d of decl.childrenForFieldName("declarator")) {
    const name = d.childForFieldName("name")?.text;
    const value = d.childForFieldName("value");
    const type =
      declared === "var" ? (value?.type === "object_creation_expression" ? typeName(value.childForFieldName("type")) : null) : declared;
    if (name && type) locals.set(name, type);
  }
}

function invocation(node: Node): Invocation[] {
  if (node.type === "method_reference") {
    const [target, method] = node.namedChildren;
    if (!target || !method || method.type !== "identifier") return [];
    return [{ receiver: receiverOf(target), name: method.text, arity: -1, line: lineOf(node) }];
  }
  const name = node.childForFieldName("name")?.text;
  if (!name) return [];
  const object = node.childForFieldName("object");
  return [{ receiver: object ? receiverOf(object) : { kind: "none" }, name, arity: arityOf(node), line: lineOf(node) }];
}

function arityOf(call: Node): number {
  return call.childForFieldName("arguments")?.namedChildren.filter((c) => !c.type.includes("comment")).length ?? 0;
}

/** The receiver of a call; a chain deeper than a few links is `unknown` (fluent builders reach nothing in the repo). */
function receiverOf(node: Node, depth = 0): Receiver {
  if (depth > 8) return { kind: "unknown" };
  switch (node.type) {
    case "this":
      return { kind: "this" };
    case "super":
      return { kind: "super" };
    case "identifier":
    case "type_identifier":
      return { kind: "name", name: node.text };
    case "field_access": {
      const object = node.childForFieldName("object");
      const field = node.childForFieldName("field")?.text;
      return object && field ? { kind: "field", of: receiverOf(object, depth + 1), name: field } : { kind: "unknown" };
    }
    case "method_invocation": {
      const name = node.childForFieldName("name")?.text;
      const object = node.childForFieldName("object");
      if (!name) return { kind: "unknown" };
      return { kind: "call", of: object ? receiverOf(object, depth + 1) : { kind: "none" }, name, arity: arityOf(node) };
    }
    case "object_creation_expression": {
      const type = typeName(node.childForFieldName("type"));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "parenthesized_expression":
    case "cast_expression": {
      const type = node.type === "cast_expression" ? typeName(node.childForFieldName("type")) : null;
      if (type) return { kind: "new", type };
      const inner = node.namedChildren.at(-1);
      return inner ? receiverOf(inner, depth + 1) : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

/** The simple name of a type without type arguments and array dimensions; `null` for `void` and primitives. */
export function typeName(node: Node | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "scoped_type_identifier":
      return simpleName(node.text.replace(/<.*$/, ""));
    case "generic_type":
      return typeName(node.namedChildren[0]);
    case "array_type":
      return null;
    default:
      return null;
  }
}

function hasModifier(node: Node, keyword: string): boolean {
  return node.namedChildren.find((c) => c.type === "modifiers")?.children.some((c) => c.type === keyword) ?? false;
}
