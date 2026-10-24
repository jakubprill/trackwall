import { closingIndex, isIdent, isPunct, type Token, tokenize } from "./java-tokens.ts";

/**
 * Plik Javy albo Kotlina jako typy z adnotacjami i metodami (§4.6, ADR-30): tyle składni, ile trzeba, żeby znaleźć
 * kontrolery Spring, interfejsy Feign i `@HttpExchange`, ich mapowania, stałe tekstowe (`static final String`,
 * `const val`) i pola wstrzykiwane przez `@Value`. Bez pełnego parsera: ciało metody jest pomijane jako blok, a kod,
 * którego ten odczyt nie rozumie, po prostu nie daje faktów.
 */

export interface JavaAnnotation {
  /** Ostatni człon nazwy (`GetMapping` z `@org.springframework...GetMapping`). */
  name: string;
  line: number;
  /** Tokeny między nawiasami; `null` bez nawiasów. */
  args: Token[] | null;
}

export interface JavaMethod {
  name: string;
  line: number;
  annotations: JavaAnnotation[];
}

export interface JavaType {
  name: string;
  /** `class`, `interface`, `enum`, `record` albo `object` (Kotlin). */
  keyword: string;
  line: number;
  annotations: JavaAnnotation[];
  methods: JavaMethod[];
  /** Proste nazwy typów z `extends` / `implements` (Kotlin: po `:`). */
  supertypes: string[];
}

export interface JavaFile {
  path: string;
  types: JavaType[];
  /** Wyrażenia stałych tekstowych po nazwie (`NAZWA`) i po typie (`Typ.NAZWA`), do policzenia przez `java-expr.ts`. */
  constants: Map<string, Token[]>;
  tokens: Token[];
}

const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record", "object"]);
/** Słowa, po których `(` nie otwiera listy parametrów metody. */
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "this", "super", "when", "throw"]);
/** Słowa kończące listę nadtypów w deklaracji typu. */
const SUPERTYPE_MARKERS = new Set(["extends", "implements", ":", ","]);

type Frame = { kind: "type"; type: JavaType } | { kind: "block" };

export function parseJavaFile(path: string, text: string): JavaFile {
  const tokens = tokenize(text);
  const parser = new SourceParser(tokens);
  parser.run();
  return { path, types: parser.types, constants: parser.constants, tokens };
}

class SourceParser {
  readonly types: JavaType[] = [];
  readonly constants = new Map<string, Token[]>();
  private readonly tokens: readonly Token[];
  private readonly frames: Frame[] = [];
  private pending: JavaAnnotation[] = [];
  private pendingType: JavaType | null = null;
  /** Indeks pierwszego tokenu bieżącej deklaracji (za ostatnim `;`, `{` albo `}`). */
  private statementStart = 0;
  private i = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  run(): void {
    while (this.i < this.tokens.length) this.step();
  }

  private step(): void {
    const t = this.tokens[this.i];
    if (isPunct(t, "@") && !isIdent(this.tokens[this.i + 1], "interface")) return this.annotation();
    if (isPunct(t, "{")) return this.open();
    if (isPunct(t, "}")) return this.close();
    if (isPunct(t, ";")) return this.boundary(this.i + 1);
    if (this.atMember() && t?.kind === "ident") return this.memberIdent(t.text);
    this.i++;
  }

  private atMember(): boolean {
    const top = this.frames.at(-1);
    return top === undefined || top.kind === "type";
  }

  private currentType(): JavaType | undefined {
    const top = this.frames.at(-1);
    return top?.kind === "type" ? top.type : undefined;
  }

  private annotation(): void {
    let j = this.i + 1;
    let name = "";
    const line = this.tokens[j]?.line ?? 0;
    for (let t = this.tokens[j]; t?.kind === "ident"; t = this.tokens[j]) {
      name = t.text;
      j++;
      if (!isPunct(this.tokens[j], ".") || !isIdent(this.tokens[j + 1])) break;
      j++;
    }
    let args: Token[] | null = null;
    if (isPunct(this.tokens[j], "(")) {
      const end = closingIndex(this.tokens, j);
      args = this.tokens.slice(j + 1, end - 1);
      j = end;
    }
    if (name !== "" && this.atMember()) this.pending.push({ name, line, args });
    this.i = Math.max(j, this.i + 1);
  }

  private open(): void {
    if (this.pendingType) {
      this.types.push(this.pendingType);
      this.frames.push({ kind: "type", type: this.pendingType });
      this.pendingType = null;
    } else this.frames.push({ kind: "block" });
    this.boundary(this.i + 1);
  }

  private close(): void {
    this.frames.pop();
    this.boundary(this.i + 1);
  }

  private boundary(next: number): void {
    this.pending = [];
    this.statementStart = next;
    this.i = next;
  }

  private memberIdent(text: string): void {
    const next = this.tokens[this.i + 1];
    if (TYPE_KEYWORDS.has(text)) return this.typeDeclaration(text);
    if (isPunct(next, "(") && !this.pendingType && this.currentType() && !NOT_METHODS.has(text)) return this.method(text);
    if (isPunct(next, "=") && !this.pendingType) return this.constant(text);
    if (this.pendingType && SUPERTYPE_MARKERS.has(this.previousText()) && text !== "extends" && text !== "implements")
      this.pendingType.supertypes.push(text);
    this.i++;
  }

  private previousText(): string {
    const prev = this.tokens[this.i - 1];
    return prev?.kind === "ident" || prev?.kind === "punct" ? prev.text : "";
  }

  /** `class Nazwa`, `enum class Nazwa` (Kotlin), `companion object {` bez nazwy. */
  private typeDeclaration(keyword: string): void {
    let j = this.i + 1;
    if (isIdent(this.tokens[j], "class")) j++;
    const nameToken = this.tokens[j];
    const name = nameToken?.kind === "ident" ? nameToken.text : "Companion";
    this.pendingType = { name, keyword, line: this.tokens[this.i]?.line ?? 0, annotations: this.pending, methods: [], supertypes: [] };
    this.pending = [];
    this.i = nameToken?.kind === "ident" ? j + 1 : j;
  }

  private method(name: string): void {
    const type = this.currentType();
    type?.methods.push({ name, line: this.tokens[this.i]?.line ?? 0, annotations: this.pending });
    this.pending = [];
    this.i = closingIndex(this.tokens, this.i + 1);
  }

  /**
   * Pole z wartością na poziomie typu albo pliku: stała tekstowa, gdy deklaracja ma `final` (Java) albo `const` (Kotlin).
   * Wyrażenie kończy `;` albo, w Kotlinie bez średników, nowa linia, która nie kontynuuje sklejania `+`.
   */
  private constant(name: string): void {
    const declaration = this.tokens.slice(this.statementStart, this.i);
    const end = expressionEnd(this.tokens, this.i + 2);
    const type = this.currentType();
    if (declaration.some((t) => isIdent(t, "final") || isIdent(t, "const"))) {
      const expr = this.tokens.slice(this.i + 2, end);
      if (!this.constants.has(name)) this.constants.set(name, expr);
      // Stała z poziomu pliku (Kotlin `const val` poza typem) jest tylko pod nazwą.
      if (type) this.constants.set(`${type.name}.${name}`, expr);
    }
    this.i = end;
    this.statementStart = end;
  }
}

/** Indeks za wyrażeniem od `from`: do `;` poza nawiasami albo do nowej linii bez `+` na styku. */
function expressionEnd(tokens: readonly Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    if (depth === 0 && (isPunct(t, ";") || isPunct(t, "}") || isPunct(t, ")"))) return i;
    if (depth === 0 && i > from && t && prev && t.line > prev.line && !isPunct(t, "+") && !isPunct(prev, "+")) return i;
    if (isPunct(t, "(") || isPunct(t, "{") || isPunct(t, "[")) depth++;
    if (isPunct(t, ")") || isPunct(t, "}") || isPunct(t, "]")) depth = Math.max(0, depth - 1);
  }
  return tokens.length;
}

/** Adnotacja o nazwie `name` z listy. */
export function annotationNamed(annotations: readonly JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined {
  return annotations.find((a) => names.includes(a.name));
}
