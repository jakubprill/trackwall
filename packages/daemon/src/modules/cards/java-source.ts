import { closingIndex, isIdent, isPunct, type Token, tokenize } from "./java-tokens.ts";

/**
 * A Java or Kotlin file as types with annotations and methods (§4.6, ADR-30): as much syntax as it takes to find Spring
 * controllers, Feign and `@HttpExchange` interfaces, their mappings, text constants (`static final String`,
 * `const val`) and fields injected with `@Value`. No full parser: a method body is skipped as a block, and code this
 * reading does not understand simply gives no facts.
 */

export interface JavaAnnotation {
  /** The last part of the name (`GetMapping` from `@org.springframework...GetMapping`). */
  name: string;
  line: number;
  /** The tokens between the brackets; `null` without brackets. */
  args: Token[] | null;
}

export interface JavaMethod {
  name: string;
  line: number;
  annotations: JavaAnnotation[];
}

export interface JavaType {
  name: string;
  /** `class`, `interface`, `enum`, `record` or `object` (Kotlin). */
  keyword: string;
  line: number;
  annotations: JavaAnnotation[];
  methods: JavaMethod[];
  /** Simple type names from `extends` / `implements` (Kotlin: after `:`). */
  supertypes: string[];
}

export interface JavaFile {
  path: string;
  types: JavaType[];
  /** Text constant expressions by name (`NAME`) and by type (`Type.NAME`), to be resolved by `java-expr.ts`. */
  constants: Map<string, Token[]>;
  tokens: Token[];
}

const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record", "object"]);
/** Words after which `(` does not open a method's parameter list. */
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "this", "super", "when", "throw"]);
/** Words that end the list of supertypes in a type declaration. */
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
  /** The index of the first token of the current declaration (after the last `;`, `{` or `}`). */
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
    if (isPunct(t, "@") && !isIdent(this.tokens[this.i + 1], "interface")) this.annotation();
    else if (isPunct(t, "{")) this.open();
    else if (isPunct(t, "}")) this.close();
    else if (isPunct(t, ";")) this.boundary(this.i + 1);
    else if (this.atMember() && t?.kind === "ident") this.memberIdent(t.text);
    else this.i++;
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
    if (TYPE_KEYWORDS.has(text)) this.typeDeclaration(text);
    // The Kotlin primary constructor (`class A(val b: B)`, `class A @Inject constructor(…)`): parameter types are not supertypes.
    else if (this.pendingType && text === "constructor" && isPunct(next, "(")) this.i = closingIndex(this.tokens, this.i + 1);
    else if (isPunct(next, "(") && !this.pendingType && this.currentType() && !NOT_METHODS.has(text)) this.method(text);
    else if (isPunct(next, "=") && !this.pendingType) this.constant(text);
    else {
      if (this.pendingType && SUPERTYPE_MARKERS.has(this.previousText()) && text !== "extends" && text !== "implements")
        this.pendingType.supertypes.push(text);
      this.i++;
    }
  }

  private previousText(): string {
    const prev = this.tokens[this.i - 1];
    return prev?.kind === "ident" || prev?.kind === "punct" ? prev.text : "";
  }

  /** `class Name`, `enum class Name` (Kotlin), `companion object {` without a name. */
  private typeDeclaration(keyword: string): void {
    let j = this.i + 1;
    if (isIdent(this.tokens[j], "class")) j++;
    const nameToken = this.tokens[j];
    const name = nameToken?.kind === "ident" ? nameToken.text : "Companion";
    this.pendingType = { name, keyword, line: this.tokens[this.i]?.line ?? 0, annotations: this.pending, methods: [], supertypes: [] };
    this.pending = [];
    this.i = nameToken?.kind === "ident" ? j + 1 : j;
    this.i = afterTypeParameters(this.tokens, this.i);
    if (isPunct(this.tokens[this.i], "(")) this.i = closingIndex(this.tokens, this.i);
  }

  private method(name: string): void {
    const type = this.currentType();
    type?.methods.push({ name, line: this.tokens[this.i]?.line ?? 0, annotations: this.pending });
    this.pending = [];
    this.i = closingIndex(this.tokens, this.i + 1);
  }

  /**
   * A field with a value at type or file level: a text constant when the declaration has `final` (Java) or `const` (Kotlin).
   * The expression ends with `;` or, in Kotlin without semicolons, with a new line that does not continue a `+` concatenation.
   */
  private constant(name: string): void {
    const declaration = this.tokens.slice(this.statementStart, this.i);
    const end = expressionEnd(this.tokens, this.i + 2);
    const type = this.currentType();
    if (declaration.some((t) => isIdent(t, "final") || isIdent(t, "const"))) {
      const expr = this.tokens.slice(this.i + 2, end);
      if (!this.constants.has(name)) this.constants.set(name, expr);
      // A file-level constant (Kotlin `const val` outside a type) is only under its name.
      if (type) this.constants.set(`${type.name}.${name}`, expr);
    }
    this.i = end;
    this.statementStart = end;
  }
}

/**
 * The index after type parameters (`<T : Base>`) from `from`; `from` when there are none. Bounded, because the file
 * comes from the repo.
 */
function afterTypeParameters(tokens: readonly Token[], from: number): number {
  if (!isPunct(tokens[from], "<")) return from;
  let depth = 0;
  for (let i = from; i < tokens.length && i < from + 200; i++) {
    if (isPunct(tokens[i], "<")) depth++;
    else if (isPunct(tokens[i], ">") && --depth === 0) return i + 1;
  }
  return from;
}

/** The index after an expression from `from`: up to `;` outside brackets or up to a new line without `+` at the joint. */
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

/** The annotation named `name` from the list. */
export function annotationNamed(annotations: readonly JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined {
  return annotations.find((a) => names.includes(a.name));
}
