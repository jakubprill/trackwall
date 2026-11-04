import type { Node } from "web-tree-sitter";
import { lineOf, typeText } from "./contract-syntax.ts";

/**
 * The public API of a Java file (§4.6, ADR-205): the types another module can see (public, and nested public in them; an
 * interface's members are public unless private) with their visible members, read from the syntax tree. A member is
 * known by its key (a method's name and parameter types, a field's or enum constant's name) and described by its
 * signature, so a changed return or field type is a change of the same member, and an overload is another member.
 * Plain values without nodes, because the tree is freed after reading (`syntax-tree.ts`).
 */

export interface ApiType {
  /** The package, `""` in the default package. */
  pkg: string;
  /** The fully qualified name, nested types joined with `.`. */
  name: string;
  line: number;
  /** The kind, type parameters, supertypes and, for a record, its components, as one text. */
  header: string;
  /** Visible members by key, each with its signature. */
  members: Map<string, string>;
}

const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);
const INTERFACE_LIKE = new Set(["interface_declaration", "annotation_type_declaration"]);

/** The public types of a Java file with their visible members. */
export function readJavaApi(root: Node): ApiType[] {
  const pkg = root.namedChildren.find((c) => c.type === "package_declaration");
  const name = pkg?.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
  const packageName = name ? typeText(name) : "";
  const prefix = packageName === "" ? "" : `${packageName}.`;
  return root.namedChildren.flatMap((c) => (TYPE_DECLARATIONS.has(c.type) ? apiTypes(c, packageName, prefix, null) : []));
}

/** Where a type is declared: at the top of the file (`null`), or nested in a class or in an interface. */
type Outer = "class" | "interface" | null;

function apiTypes(node: Node, pkg: string, prefix: string, outer: Outer): ApiType[] {
  const name = node.childForFieldName("name");
  // A nested `protected` type is seen by the consumer's subclasses, like a member.
  if (!name || !visible(node, outer === "interface", outer !== null)) return [];
  const qualified = `${prefix}${name.text}`;
  const body = node.childForFieldName("body");
  const memberOfInterface = INTERFACE_LIKE.has(node.type);
  const members = new Map<string, string>();
  const nested: ApiType[] = [];
  const kind = memberOfInterface ? "interface" : "class";
  for (const member of bodyMembers(body)) {
    if (TYPE_DECLARATIONS.has(member.type)) nested.push(...apiTypes(member, pkg, `${qualified}.`, kind));
    else for (const [key, signature] of memberSignatures(member, name.text, memberOfInterface)) members.set(key, signature);
  }
  // A class without a constructor has the implicit one without arguments, which a new constructor takes away.
  if (node.type === "class_declaration" && !bodyMembers(body).some((m) => m.type === "constructor_declaration"))
    members.set(`${name.text}()`, `${name.text}()`);
  return [{ pkg, name: qualified, line: lineOf(name), header: header(node, outer), members }, ...nested];
}

/** The members of a type's body; an enum's body declarations after its constants count too. */
function bodyMembers(body: Node | null): Node[] {
  return (body?.namedChildren ?? []).flatMap((c) => (c.type === "enum_body_declarations" ? c.namedChildren : [c]));
}

function memberSignatures(member: Node, typeName: string, inInterface: boolean): [string, string][] {
  if (member.type === "enum_constant") return enumConstant(member);
  // An interface's fields are public constants and its methods public unless private.
  if (!visible(member, inInterface, true)) return [];
  if (member.type === "method_declaration" || member.type === "constructor_declaration") return method(member, typeName, inInterface);
  if (member.type === "field_declaration" || member.type === "constant_declaration") return fields(member, inInterface);
  if (member.type === "annotation_type_element_declaration") return annotationElement(member);
  return [];
}

function enumConstant(member: Node): [string, string][] {
  const name = member.childForFieldName("name");
  return name ? [[name.text, `constant ${name.text}`]] : [];
}

function method(member: Node, typeName: string, inInterface: boolean): [string, string][] {
  const name = member.childForFieldName("name");
  if (!name) return [];
  const key = `${member.type === "constructor_declaration" ? typeName : name.text}(${parameterTypes(member)})`;
  const returns = member.childForFieldName("type");
  const prefix = modifiers(member, abstractMethod(member, inInterface));
  return [[key, returns ? `${prefix}${key}: ${typeText(returns)}` : `${prefix}${key}`]];
}

function fields(member: Node, inInterface: boolean): [string, string][] {
  const type = member.childForFieldName("type");
  if (!type) return [];
  // An interface's field is `static final` whether the code says so or not.
  const prefix = inInterface ? "static final " : modifiers(member);
  return member.childrenForFieldName("declarator").flatMap((d): [string, string][] => {
    const name = d.childForFieldName("name");
    return name ? [[name.text, `${prefix}${name.text}: ${typeText(type)}`]] : [];
  });
}

/** An annotation element without a default must be given at every use, so it counts as abstract: a new one breaks them. */
function annotationElement(member: Node): [string, string][] {
  const name = member.childForFieldName("name");
  const type = member.childForFieldName("type");
  const required = member.childForFieldName("value") === null ? "abstract " : "";
  return name && type ? [[`${name.text}()`, `${required}${name.text}(): ${typeText(type)}`]] : [];
}

/** Whether another module sees the declaration: `public`, `protected` for a member, or any but `private` in an interface. */
function visible(node: Node, inInterface: boolean, member: boolean): boolean {
  const words = modifierWords(node);
  if (words.has("private")) return false;
  return words.has("public") || (member && words.has("protected")) || inInterface;
}

function parameterTypes(method: Node): string {
  return (method.childForFieldName("parameters")?.namedChildren ?? [])
    .flatMap((p) => {
      // A varargs parameter has its type as a plain child, not in the `type` field.
      if (p.type === "spread_parameter") {
        const type = p.namedChildren.find((c) => c.type !== "modifiers" && c.type !== "variable_declarator");
        return type ? [`${typeText(type)}...`] : [];
      }
      const type = p.childForFieldName("type");
      return type ? [typeText(type)] : [];
    })
    .join(", ");
}

/**
 * Whether every implementation must have the method: `abstract`, or an interface method without a body that is not
 * `static`, `default` or `private`. A new one breaks the consumer's classes that implement or extend the type.
 */
function abstractMethod(method: Node, inInterface: boolean): boolean {
  const words = modifierWords(method);
  if (words.has("abstract")) return true;
  return inInterface && method.childForFieldName("body") === null && !words.has("static") && !words.has("default");
}

/** The modifiers that change how a caller uses a member, as a prefix: `static`, `final`, `abstract`. */
function modifiers(node: Node, abstract = false): string {
  const words = modifierWords(node);
  const used = ["static", "final"].filter((w) => words.has(w));
  return [...used, ...(abstract ? ["abstract"] : [])].map((w) => `${w} `).join("");
}

function modifierWords(node: Node): Set<string> {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  return new Set((mods?.children ?? []).map((c) => c.type));
}

/**
 * The declaration's head without its body, annotations and comments, with the modifiers that limit its users:
 * `final class Foo<T> extends Bar implements Baz`. `static` counts only for a class nested in a class, where its absence
 * makes it an inner class; elsewhere a nested type is static anyway.
 */
function header(node: Node, outer: Outer): string {
  const words = modifierWords(node);
  const limits = ["static", "abstract", "final", "sealed", "non-sealed"].filter(
    (w) => words.has(w) && (w !== "static" || (outer === "class" && node.type === "class_declaration")),
  );
  const head = node.children.filter((c) => c.type !== "modifiers" && !c.type.endsWith("_body")).map(typeText);
  return [...limits, ...head].join(" ");
}
