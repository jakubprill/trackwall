import type { DtoField } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";
import { lineOf, linesOf, type SourceSyntax, simpleName, type TypeDeclaration, typeText } from "./contract-syntax.ts";

/** Type declarations and method contracts from the syntax tree of a Java file (ADR-38). */
export function readJavaSyntax(root: Node): SourceSyntax {
  const types = root.descendantsOfType(["record_declaration", "class_declaration", "enum_declaration"]).flatMap(javaType);
  const methods = root.descendantsOfType("method_declaration").flatMap((method) => {
    const name = method.childForFieldName("name");
    const returns = method.childForFieldName("type");
    return name ? [{ name: name.text, ...linesOf(method), request: requestBody(method), returns: returns ? typeText(returns) : null }] : [];
  });
  return { types, methods };
}

function javaType(node: Node): TypeDeclaration[] {
  const name = node.childForFieldName("name");
  if (!name) return [];
  const declared = { name: name.text, line: lineOf(name) };
  if (node.type === "enum_declaration") {
    const values = enumConstants(node);
    return values.length > 0 ? [{ ...declared, kind: "enum", values }] : [];
  }
  const record = node.type === "record_declaration";
  const fields = record ? parameters(node) : instanceFields(node);
  // A type without fields (a service, an exception, a controller, an empty record or an enum) carries no data, so it is not a DTO.
  return fields.length > 0 ? [{ ...declared, kind: record ? "record" : "class", fields }] : [];
}

function parameters(record: Node): DtoField[] {
  return (record.childForFieldName("parameters")?.namedChildren ?? []).flatMap((p) => field(p, p));
}

/** A class's instance fields: field declarations in the body without `static` (constants and loggers are not DTO content). */
function instanceFields(type: Node): DtoField[] {
  const body = type.childForFieldName("body");
  return (body?.namedChildren ?? [])
    .filter((member) => member.type === "field_declaration" && !hasModifier(member, "static"))
    .flatMap((member) => member.childrenForFieldName("declarator").flatMap((d) => field(member, d)));
}

/** A field from the declaration's type and the declarator's name; array dimensions at the name (`int b[]`) belong to the type. */
function field(declaration: Node, declarator: Node): DtoField[] {
  const name = declarator.childForFieldName("name");
  const type = declaration.childForFieldName("type");
  const dimensions = declarator.childForFieldName("dimensions");
  return name && type ? [{ name: name.text, type: typeText(type) + (dimensions ? typeText(dimensions) : "") }] : [];
}

function enumConstants(type: Node): string[] {
  const body = type.childForFieldName("body");
  return (body?.namedChildren ?? []).filter((c) => c.type === "enum_constant").flatMap((c) => c.childForFieldName("name")?.text ?? []);
}

function requestBody(method: Node): string | null {
  const parameter = method
    .childForFieldName("parameters")
    ?.namedChildren.find((p) => p.type === "formal_parameter" && annotations(p).includes("RequestBody"));
  const type = parameter?.childForFieldName("type");
  return type ? typeText(type) : null;
}

function modifiersOf(node: Node): Node | undefined {
  return node.namedChildren.find((c) => c.type === "modifiers");
}

function hasModifier(node: Node, keyword: string): boolean {
  return modifiersOf(node)?.children.some((c) => c.type === keyword) ?? false;
}

function annotations(node: Node): string[] {
  return (modifiersOf(node)?.namedChildren ?? [])
    .filter((c) => c.type === "marker_annotation" || c.type === "annotation")
    .flatMap((a) => {
      const name = a.childForFieldName("name");
      return name ? [simpleName(name.text)] : [];
    });
}
