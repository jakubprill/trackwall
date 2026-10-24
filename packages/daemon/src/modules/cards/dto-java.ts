import type { DtoField } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";
import { addMethod, lineOf, type MethodContract, type SourceSyntax, simpleName, type TypeDeclaration } from "./dto-syntax.ts";

/** Deklaracje typów i kontrakty metod z drzewa składni pliku Javy (ADR-38). */
export function readJavaSyntax(root: Node): SourceSyntax {
  const types = root.descendantsOfType(["record_declaration", "class_declaration", "enum_declaration"]).flatMap(javaType);
  const methods = new Map<string, MethodContract>();
  for (const method of root.descendantsOfType("method_declaration"))
    addMethod(methods, method.childForFieldName("name")?.text, {
      request: requestBody(method),
      returns: method.childForFieldName("type")?.text ?? null,
    });
  return { types, methods };
}

function javaType(node: Node): TypeDeclaration[] {
  const name = node.childForFieldName("name");
  if (!name) return [];
  const declared = { name: name.text, line: lineOf(name) };
  if (node.type === "record_declaration") return [{ ...declared, kind: "record", fields: parameters(node), values: [] }];
  if (node.type === "enum_declaration") return [{ ...declared, kind: "enum", fields: [], values: enumConstants(node) }];
  return [{ ...declared, kind: "class", fields: instanceFields(node), values: [] }];
}

function parameters(record: Node): DtoField[] {
  return (record.childForFieldName("parameters")?.namedChildren ?? []).flatMap((p) => field(p, p.childForFieldName("name")));
}

/** Pola instancji klasy: deklaracje pól w ciele bez `static` (stałe i loggery nie są treścią DTO). */
function instanceFields(type: Node): DtoField[] {
  const body = type.childForFieldName("body");
  return (body?.namedChildren ?? [])
    .filter((member) => member.type === "field_declaration" && !hasModifier(member, "static"))
    .flatMap((member) => member.childrenForFieldName("declarator").flatMap((d) => field(member, d.childForFieldName("name"))));
}

function field(declaration: Node, name: Node | null): DtoField[] {
  const type = declaration.childForFieldName("type");
  return name && type ? [{ name: name.text, type: type.text }] : [];
}

function enumConstants(type: Node): string[] {
  const body = type.childForFieldName("body");
  return (body?.namedChildren ?? []).filter((c) => c.type === "enum_constant").flatMap((c) => c.childForFieldName("name")?.text ?? []);
}

function requestBody(method: Node): string | null {
  const parameter = method
    .childForFieldName("parameters")
    ?.namedChildren.find((p) => p.type === "formal_parameter" && annotations(p).includes("RequestBody"));
  return parameter?.childForFieldName("type")?.text ?? null;
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
