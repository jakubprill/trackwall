import type { DtoField } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";
import { lineOf, linesOf, type SourceSyntax, simpleName, type TypeDeclaration, typeText } from "./contract-syntax.ts";

/**
 * Deklaracje typów i kontrakty funkcji z drzewa składni pliku Kotlina (ADR-38). Gramatyka nie nazywa pól typu
 * w parametrach i funkcjach, więc typ to nazwany węzeł za dwukropkiem.
 */
export function readKotlinSyntax(root: Node): SourceSyntax {
  const types = root.descendantsOfType("class_declaration").flatMap(kotlinType);
  const methods = root.descendantsOfType("function_declaration").flatMap((fn) => {
    const name = fn.childForFieldName("name");
    const returns = typeAfterColon(fn);
    return name ? [{ name: name.text, ...linesOf(fn), request: requestBody(fn), returns: returns ? typeText(returns) : null }] : [];
  });
  return { types, methods };
}

function kotlinType(node: Node): TypeDeclaration[] {
  const name = node.childForFieldName("name");
  if (!name || node.children.some((c) => c.type === "interface")) return [];
  const declared = { name: name.text, line: lineOf(name) };
  const modifiers = classModifiers(node);
  const enumBody = node.namedChildren.find((c) => c.type === "enum_class_body");
  if (modifiers.includes("enum") || enumBody) return [{ ...declared, kind: "enum", values: enumEntries(enumBody) }];
  const data = modifiers.includes("data");
  const fields = [...constructorProperties(node, data), ...bodyProperties(node)];
  if (data) return [{ ...declared, kind: "data-class", fields }];
  // Klasa bez właściwości (serwis z zależnościami w konstruktorze, wyjątek) nie niesie danych, więc nie jest DTO.
  return fields.length > 0 ? [{ ...declared, kind: "class", fields }] : [];
}

function classModifiers(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  return (modifiers?.namedChildren ?? []).filter((c) => c.type === "class_modifier").map((c) => c.text);
}

/** Parametry konstruktora głównego, które są właściwościami (`val`/`var`); w `data class` wszystkie. */
function constructorProperties(node: Node, data: boolean): DtoField[] {
  const parameters = node.namedChildren
    .find((c) => c.type === "primary_constructor")
    ?.namedChildren.find((c) => c.type === "class_parameters");
  return (parameters?.namedChildren ?? [])
    .filter((p) => p.type === "class_parameter" && (data || p.children.some((c) => c.type === "val" || c.type === "var")))
    .flatMap(namedTyped);
}

/** Właściwości zadeklarowane wprost w ciele klasy (bez tych z funkcji i `companion object`). */
function bodyProperties(node: Node): DtoField[] {
  const body = node.namedChildren.find((c) => c.type === "class_body");
  return (body?.namedChildren ?? [])
    .filter((m) => m.type === "property_declaration")
    .flatMap((m) => {
      const variable = m.namedChildren.find((c) => c.type === "variable_declaration");
      return variable ? namedTyped(variable) : [];
    });
}

/** Węzeł z nazwą (pierwszy identyfikator) i typem za dwukropkiem; bez jawnego typu nie ma pola do pokazania. */
function namedTyped(node: Node): DtoField[] {
  const name = node.namedChildren.find((c) => c.type === "identifier");
  const type = typeAfterColon(node);
  return name && type ? [{ name: name.text, type: typeText(type) }] : [];
}

function typeAfterColon(node: Node): Node | null {
  const colon = node.children.findIndex((c) => c.type === ":");
  return colon < 0 ? null : (node.children.slice(colon + 1).find((c) => c.isNamed) ?? null);
}

function enumEntries(body: Node | undefined): string[] {
  return (body?.namedChildren ?? [])
    .filter((c) => c.type === "enum_entry")
    .flatMap((e) => e.namedChildren.find((c) => c.type === "identifier")?.text ?? []);
}

/** Typ parametru, przed którym stoi `@RequestBody`; adnotacje parametru są w gramatyce osobnym węzłem przed nim. */
function requestBody(fn: Node): string | null {
  let annotated = false;
  for (const child of fn.namedChildren.find((c) => c.type === "function_value_parameters")?.namedChildren ?? []) {
    if (child.type === "parameter_modifiers") annotated = annotationNames(child).includes("RequestBody");
    else if (child.type === "parameter") {
      const type = typeAfterColon(child);
      if (annotated) return type ? typeText(type) : null;
      annotated = false;
    }
  }
  return null;
}

function annotationNames(modifiers: Node): string[] {
  return modifiers.descendantsOfType("annotation").flatMap((a) => {
    // `@RequestBody` to `user_type`, `@RequestBody(required = false)` to `constructor_invocation` z `user_type` w środku.
    const type =
      a.namedChildren.find((c) => c.type === "user_type") ??
      a.namedChildren.find((c) => c.type === "constructor_invocation")?.namedChildren.find((c) => c.type === "user_type");
    return type ? [simpleName(type.text)] : [];
  });
}
