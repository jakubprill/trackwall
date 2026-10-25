import type { Dto } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";

/**
 * What a Java or Kotlin file says about endpoint contracts (ADR-38), read from the syntax tree (`contract-java.ts`,
 * `contract-kotlin.ts`): type declarations that may be DTOs, and the request and response body types of methods. Plain
 * values without nodes, because the tree is freed after reading (`syntax-tree.ts`).
 */
export interface SourceSyntax {
  types: TypeDeclaration[];
  /** The file's methods and functions in code order, also from nested types. */
  methods: MethodContract[];
}

type WithoutEvidence<T> = T extends unknown ? Omit<T, "evidence"> : never;

/** A DTO without evidence (only the card knows the path) with the line of the type name. */
export type TypeDeclaration = WithoutEvidence<Dto> & { line: number };

export interface MethodContract {
  name: string;
  /** Lines (from 1) from the first annotation to the end of the body: the endpoint's mapping line lies within them. */
  startLine: number;
  endLine: number;
  /** The type of the `@RequestBody` parameter in type notation (`typeText`). */
  request: string | null;
  /** The return type in type notation, with wrappers (`ResponseEntity<OrderDto>`). */
  returns: string | null;
}

/** The line (from 1) where the node starts. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** The lines of method `node` for `MethodContract`. */
export function linesOf(node: Node): Pick<MethodContract, "startLine" | "endLine"> {
  return { startLine: lineOf(node), endLine: node.endPosition.row + 1 };
}

/** The last part of a qualified name (`RequestBody` from `org.springframework...RequestBody`). */
export function simpleName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Annotation nodes of both grammars: in type notation (`List<@Valid Line>`) they are not part of the type. */
const ANNOTATIONS = new Set(["annotation", "marker_annotation"]);
const WORD_CHAR = /[\w$]/;

/**
 * Type notation from a node: the text of the leaves without annotations and comments, with a space only between two words
 * or after the `?` of a Java wildcard (`List<? extends Line>`, `Map<String,Line>`), so the same type has the same
 * notation regardless of code formatting. One pass over the leaves (a type from a repo can have hundreds of thousands of
 * arguments), a stack instead of recursion, because a type can be nested deeper than the call stack reaches.
 */
export function typeText(node: Node): string {
  const parts: string[] = [];
  let wordEnded = false;
  for (const text of leafTexts(node)) {
    // A missing token (`MISSING`) is empty and does not separate words.
    if (text === "") continue;
    if (wordEnded && WORD_CHAR.test(text[0] ?? "")) parts.push(" ");
    parts.push(text);
    const last = text.at(-1) ?? "";
    wordEnded = last === "?" || WORD_CHAR.test(last);
  }
  return parts.join("");
}

/** The text of a node's leaves in code order, without annotations and comments. */
function* leafTexts(node: Node): Generator<string> {
  const stack = [node];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (ANNOTATIONS.has(n.type) || n.type.includes("comment")) continue;
    if (n.childCount === 0) yield n.text;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const child = n.child(i);
      if (child) stack.push(child);
    }
  }
}
