/**
 * Java and Kotlin code tokens for the HTTP extractors (§4.6, ADR-30): identifiers, strings with their value after escapes
 * and single punctuation characters, each with its line number, without comments and whitespace. One pass over the text
 * without regular expressions on the whole file, because the file comes from the repo (untrusted, §8). Syntactically
 * invalid code gives tokens without an error: the extractors take from them only what they recognise.
 */

export type Token =
  | { kind: "ident"; text: string; line: number }
  | { kind: "string"; value: string; line: number }
  | { kind: "punct"; text: string; line: number };

/** Escapes in Java and Kotlin strings; `\$` is a dollar sign in a Kotlin string (no template). */
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };

export function tokenize(text: string): Token[] {
  return new Tokenizer(text).run();
}

/**
 * Type names a file may mention in an endpoint contract (ADR-38): identifiers starting with a capital letter. A superset
 * (annotations and services are among them), because reading the commit fetches files by them before a syntax tree exists.
 */
export function referencedTypeNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const token of tokenize(text)) if (token.kind === "ident" && isTypeName(token.text)) names.add(token.text);
  return names;
}

/** Whether an identifier looks like a type name: it starts with a capital letter, as the Java and Kotlin conventions require. */
export function isTypeName(name: string): boolean {
  const first = name[0] ?? "";
  return first !== first.toLowerCase();
}

class Tokenizer {
  private readonly src: string;
  private readonly tokens: Token[] = [];
  private pos = 0;
  private line = 1;

  constructor(src: string) {
    this.src = src;
  }

  run(): Token[] {
    while (this.pos < this.src.length) this.step();
    return this.tokens;
  }

  private step(): void {
    const c = this.src[this.pos] ?? "";
    if (c === "\n") {
      this.line++;
      this.pos++;
    } else if (c === " " || c === "\t" || c === "\r" || c === "\f") this.pos++;
    else if (this.src.startsWith("//", this.pos)) this.skipTo("\n", false);
    else if (this.src.startsWith("/*", this.pos)) this.skipTo("*/", true);
    else if (this.src.startsWith('"""', this.pos)) this.textBlock();
    else if (c === '"') this.string('"');
    else if (c === "'") this.string("'");
    else if (isIdentStart(c)) this.ident();
    else {
      this.tokens.push({ kind: "punct", text: c, line: this.line });
      this.pos++;
    }
  }

  /** Skips to `end` (inclusive when `inclusive`), counting lines. */
  private skipTo(end: string, inclusive: boolean): void {
    const found = this.src.indexOf(end, this.pos + 2);
    const stop = found < 0 ? this.src.length : inclusive ? found + end.length : found;
    this.countLines(this.pos, stop);
    this.pos = stop;
  }

  /** A triple-quoted string (a Java text block, a raw Kotlin string): no escapes, across many lines. */
  private textBlock(): void {
    const line = this.line;
    const start = this.pos + 3;
    const end = this.src.indexOf('"""', start);
    const stop = end < 0 ? this.src.length : end;
    this.tokens.push({ kind: "string", value: this.src.slice(start, stop), line });
    this.countLines(this.pos, stop);
    this.pos = end < 0 ? stop : stop + 3;
  }

  /** A string or character up to the closing quote; the end of the line also ends it (an unclosed string in bad code). */
  private string(quote: string): void {
    let value = "";
    let i = this.pos + 1;
    for (; i < this.src.length; i++) {
      const c = this.src[i] ?? "";
      if (c === quote || c === "\n") break;
      if (c === "\\") {
        const next = this.src[++i] ?? "";
        value += ESCAPES[next] ?? next;
      } else value += c;
    }
    if (quote === '"') this.tokens.push({ kind: "string", value, line: this.line });
    this.pos = this.src[i] === quote ? i + 1 : i;
  }

  private ident(): void {
    let end = this.pos + 1;
    while (end < this.src.length && isIdentPart(this.src[end] ?? "")) end++;
    this.tokens.push({ kind: "ident", text: this.src.slice(this.pos, end), line: this.line });
    this.pos = end;
  }

  private countLines(from: number, to: number): void {
    for (let i = from; i < to; i++) if (this.src.charCodeAt(i) === 10) this.line++;
  }
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c >= "\u0080";
}

/**
 * Digits are part of an identifier, and a number is an identifier starting with a digit: the extractors only need it
 * not to be a string.
 */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

/**
 * The index of the token after the bracket that closes the one opened by token `open`; for a bracket that never closes
 * `open + 1` (empty content), so that the code of an unfinished file does not stretch to its end. Pairs are computed once
 * per token list (`matchingBrackets`), because the extractors ask about thousands of brackets in one file, and the file
 * comes from the repo (§8).
 */
export function closingIndex(tokens: readonly Token[], open: number): number {
  let pairs = PAIRS.get(tokens);
  if (!pairs) {
    pairs = matchingBrackets(tokens);
    PAIRS.set(tokens, pairs);
  }
  return pairs.get(open) ?? open + 1;
}

/** Bracket pairs of a token list computed once, separately for each kind of bracket. */
const PAIRS = new WeakMap<readonly Token[], Map<number, number>>();

function matchingBrackets(tokens: readonly Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const open = new Map<string, number[]>([
    ["(", []],
    ["{", []],
    ["[", []],
  ]);
  tokens.forEach((t, i) => {
    if (t.kind !== "punct") return;
    const opener = OPENERS.get(t.text);
    if (opener === undefined) open.get(t.text)?.push(i);
    else {
      const start = open.get(opener)?.pop();
      if (start !== undefined) pairs.set(start, i + 1);
    }
  });
  return pairs;
}

const OPENERS = new Map([
  [")", "("],
  ["}", "{"],
  ["]", "["],
]);

export function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

export function isIdent(token: Token | undefined, text?: string): token is Extract<Token, { kind: "ident" }> {
  return token?.kind === "ident" && (text === undefined || token.text === text);
}
