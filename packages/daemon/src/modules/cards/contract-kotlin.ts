import type { DtoField } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";
import { lineOf, linesOf, type SourceSyntax, simpleName, type TypeDeclaration, typeText } from "./contract-syntax.ts";

/**
 * Type declarations and function contracts from the syntax tree of a Kotlin file (ADR-38). The grammar does not name
 * type fields in parameters and functions, so the type is the named node after the colon.
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
  if (modifiers.includes("enum") || enumBody) {
    const values = enumEntries(enumBody);
    return values.length > 0 ? [{ ...declared, kind: "enum", values }] : [];
  }
  const data = modifiers.includes("data");
  const fields = [...constructorProperties(node, data), ...bodyProperties(node)];
  // A type without properties (a service with dependencies in its constructor, an exception) carries no data, so it is not a DTO.
  return fields.length > 0 ? [{ ...declared, kind: data ? "data-class" : "class", fields }] : [];
}

function classModifiers(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  return (modifiers?.namedChildren ?? []).filter((c) => c.type === "class_modifier").map((c) => c.text);
}

/** Primary constructor parameters that are properties (`val`/`var`); in a `data class` all of them. */
function constructorProperties(node: Node, data: boolean): DtoField[] {
  const parameters = node.namedChildren
    .find((c) => c.type === "primary_constructor")
    ?.namedChildren.find((c) => c.type === "class_parameters");
  return (parameters?.namedChildren ?? [])
    .filter((p) => p.type === "class_parameter" && (data || p.children.some((c) => c.type === "val" || c.type === "var")))
    .flatMap(namedTyped);
}

/** Properties declared directly in the class body (without those from functions and `companion object`). */
function bodyProperties(node: Node): DtoField[] {
  const body = node.namedChildren.find((c) => c.type === "class_body");
  return (body?.namedChildren ?? [])
    .filter((m) => m.type === "property_declaration")
    .flatMap((m) => {
      const variable = m.namedChildren.find((c) => c.type === "variable_declaration");
      return variable ? namedTyped(variable) : [];
    });
}

/** A node with a name (the first identifier) and a type after the colon; without an explicit type there is no field to show. */
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

/** The type of the parameter preceded by `@RequestBody`; parameter annotations are a separate node before it in the grammar. */
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
    // `@RequestBody` is a `user_type`, `@RequestBody(required = false)` is a `constructor_invocation` with a `user_type` inside.
    const type =
      a.namedChildren.find((c) => c.type === "user_type") ??
      a.namedChildren.find((c) => c.type === "constructor_invocation")?.namedChildren.find((c) => c.type === "user_type");
    return type ? [simpleName(type.text)] : [];
  });
}
