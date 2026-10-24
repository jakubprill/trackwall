import type { DtoField } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";
import { lineOf, linesOf, type SourceSyntax, simpleName, type TypeDeclaration, typeText } from "./contract-syntax.ts";

/** Deklaracje typów i kontrakty metod z drzewa składni pliku Javy (ADR-38). */
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
  if (node.type === "enum_declaration") return [{ ...declared, kind: "enum", values: enumConstants(node) }];
  const record = node.type === "record_declaration";
  const fields = record ? parameters(node) : instanceFields(node);
  // Typ bez pól (serwis, wyjątek, kontroler, pusty rekord) nie niesie danych, więc nie jest DTO.
  return fields.length > 0 ? [{ ...declared, kind: record ? "record" : "class", fields }] : [];
}

function parameters(record: Node): DtoField[] {
  return (record.childForFieldName("parameters")?.namedChildren ?? []).flatMap((p) => field(p, p));
}

/** Pola instancji klasy: deklaracje pól w ciele bez `static` (stałe i loggery nie są treścią DTO). */
function instanceFields(type: Node): DtoField[] {
  const body = type.childForFieldName("body");
  return (body?.namedChildren ?? [])
    .filter((member) => member.type === "field_declaration" && !hasModifier(member, "static"))
    .flatMap((member) => member.childrenForFieldName("declarator").flatMap((d) => field(member, d)));
}

/** Pole z typu deklaracji i nazwy deklaratora; wymiary tablicy przy nazwie (`int b[]`) należą do typu. */
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
