import type { JavaFile } from "./java-source.ts";
import { closingIndex, isIdent, isPunct, type Token } from "./java-tokens.ts";

/**
 * Wartości z wyrażeń w adnotacjach i stałych (§4.6, ADR-30): napis, sklejanie `+` napisów i stałych tekstowych
 * (`ApiPaths.ORDERS + "/{id}"`), tablica (`{…}`, `[…]`, `arrayOf(…)`) i nazwy z enumów (`RequestMethod.GET`).
 * Stała, której nie ma w czytanych plikach, zostaje jako `<Klasa.NAZWA>` (tak, jak ją zapisano), żeby było widać, skąd ścieżka pochodzi.
 */

/** Ile stałych w głąb liczyć (stała z innej stałej) i najdłuższa wartość: wyrażenia są z repo (§8). */
const MAX_DEPTH = 8;
const MAX_LENGTH = 2048;

/** Stałe tekstowe wszystkich czytanych plików repo: w pliku po nazwie, w repo po `Typ.NAZWA`. */
export class ConstantTable {
  private readonly qualified = new Map<string, Token[]>();
  /** Nazwa bez typu z innego pliku tylko wtedy, gdy w repo jest jedna (Kotlin `const val` poza typem). */
  private readonly unqualified = new Map<string, Token[] | null>();

  constructor(files: readonly JavaFile[]) {
    for (const file of files)
      for (const [name, expr] of file.constants) {
        if (name.includes(".")) this.qualified.set(name, expr);
        else this.unqualified.set(name, this.unqualified.has(name) ? null : expr);
      }
  }

  /** Wyszukiwanie stałych z punktu widzenia pliku `file`. */
  lookupIn(file: JavaFile): Lookup {
    return (chain) => {
      if (chain.length === 1) {
        const name = chain[0] ?? "";
        return file.constants.get(name) ?? this.unqualified.get(name) ?? undefined;
      }
      return this.qualified.get(chain.slice(-2).join("."));
    };
  }
}

export type Lookup = (chain: readonly string[]) => Token[] | undefined;

/** Argumenty adnotacji po nazwie; argument bez nazwy to `value`. */
export function annotationArgs(args: readonly Token[] | null): Map<string, Token[]> {
  const out = new Map<string, Token[]>();
  if (args === null) return out;
  for (const part of splitTopLevel(args)) {
    const named = isIdent(part[0]) && isPunct(part[1], "=");
    const key = named && part[0]?.kind === "ident" ? part[0].text : "value";
    out.set(key, named ? part.slice(2) : part);
  }
  return out;
}

/** Napisy z wyrażenia: jeden dla sklejania, kilka dla tablicy; puste, gdy wyrażenie nie jest tekstem. */
export function stringValues(expr: readonly Token[] | undefined, lookup: Lookup): string[] {
  if (expr === undefined || expr.length === 0) return [];
  const elements = arrayElements(expr) ?? [expr];
  return elements.map((e) => concatValue(e, lookup, 0)).filter((v) => v !== undefined);
}

/** Ostatnie człony identyfikatorów w wyrażeniu (`RequestMethod.GET`, `{GET, POST}`), np. do metod HTTP. */
export function enumNames(expr: readonly Token[] | undefined): string[] {
  if (expr === undefined) return [];
  const names: string[] = [];
  for (const [i, t] of expr.entries()) if (t.kind === "ident" && !isPunct(expr[i + 1], ".")) names.push(t.text);
  for (const t of expr) if (t.kind === "string") names.push(t.value);
  return names;
}

/** Elementy tablicy `{a, b}`, `[a, b]` albo `arrayOf(a, b)`; `undefined`, gdy wyrażenie nie jest tablicą. */
function arrayElements(expr: readonly Token[]): Token[][] | undefined {
  const first = expr[0];
  const start = isIdent(first, "arrayOf") && isPunct(expr[1], "(") ? 1 : isPunct(first, "{") || isPunct(first, "[") ? 0 : -1;
  if (start < 0 || closingIndex(expr, start) !== expr.length) return undefined;
  return splitTopLevel(expr.slice(start + 1, -1));
}

/** Sklejanie `+` napisów i stałych; `undefined`, gdy któryś składnik nie jest napisem ani nazwą. */
function concatValue(expr: readonly Token[], lookup: Lookup, depth: number): string | undefined {
  let value = "";
  for (const operand of splitConcat(expr)) {
    const part = operandValue(operand, lookup, depth);
    if (part === undefined) return undefined;
    value += part;
    if (value.length > MAX_LENGTH) return undefined;
  }
  return value;
}

function operandValue(operand: readonly Token[], lookup: Lookup, depth: number): string | undefined {
  const [first] = operand;
  if (operand.length === 1 && first?.kind === "string") return first.value;
  const chain = identChain(operand);
  if (chain === undefined) return undefined;
  const constant = depth < MAX_DEPTH ? lookup(chain) : undefined;
  const value = constant && concatValue(constant, lookup, depth + 1);
  return value ?? `<${chain.join(".")}>`;
}

/** `A.B.C` jako `["A", "B", "C"]`; `undefined` dla innego wyrażenia. */
export function identChain(tokens: readonly Token[]): string[] | undefined {
  const chain: string[] = [];
  for (const [i, t] of tokens.entries()) {
    if (i % 2 === 0 && t.kind === "ident") chain.push(t.text);
    else if (i % 2 === 1 && isPunct(t, ".")) continue;
    else return undefined;
  }
  return chain.length > 0 && tokens.length % 2 === 1 ? chain : undefined;
}

/** Części listy rozdzielone przecinkiem poza nawiasami. */
export function splitTopLevel(tokens: readonly Token[]): Token[][] {
  return splitOn(tokens, ",");
}

/** Składniki sklejania `+` poza nawiasami. */
export function splitConcat(tokens: readonly Token[]): Token[][] {
  return splitOn(tokens, "+");
}

function splitOn(tokens: readonly Token[], separator: string): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (isPunct(t, "(") || isPunct(t, "{") || isPunct(t, "[")) {
      const end = closingIndex(tokens, i);
      current.push(...tokens.slice(i, end));
      i = end - 1;
    } else if (isPunct(t, separator)) {
      parts.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length > 0) parts.push(current);
  return parts.filter((p) => p.length > 0);
}
