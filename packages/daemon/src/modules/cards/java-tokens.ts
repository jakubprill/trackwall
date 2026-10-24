/**
 * Tokeny kodu Javy i Kotlina dla ekstraktorów HTTP (§4.6, ADR-30): identyfikatory, napisy z wartością po ucieczkach
 * i pojedyncze znaki interpunkcji, każdy z numerem linii, bez komentarzy i białych znaków. Jedno przejście po tekście
 * bez wyrażeń regularnych na całym pliku, bo plik jest z repo (niezaufany, §8). Kod niepoprawny składniowo daje
 * tokeny bez błędu: ekstraktory biorą z nich tylko to, co rozpoznają.
 */

export type Token =
  | { kind: "ident"; text: string; line: number }
  | { kind: "string"; value: string; line: number }
  | { kind: "punct"; text: string; line: number };

/** Ucieczki w napisach Javy i Kotlina; `\$` to dolar w napisie Kotlina (bez szablonu). */
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };

export function tokenize(text: string): Token[] {
  return new Tokenizer(text).run();
}

/**
 * Nazwy typów, które plik może wymieniać w kontrakcie endpointu (ADR-38): identyfikatory od wielkiej litery. To nadzbiór
 * (są wśród nich adnotacje i serwisy), bo odczyt commita dociąga po nich pliki, zanim powstanie drzewo składni.
 */
export function referencedTypeNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const token of tokenize(text)) if (token.kind === "ident" && isTypeName(token.text)) names.add(token.text);
  return names;
}

/** Czy identyfikator wygląda na nazwę typu: zaczyna się wielką literą, jak każą konwencje Javy i Kotlina. */
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

  /** Pomija do `end` (włącznie, gdy `inclusive`), licząc linie. */
  private skipTo(end: string, inclusive: boolean): void {
    const found = this.src.indexOf(end, this.pos + 2);
    const stop = found < 0 ? this.src.length : inclusive ? found + end.length : found;
    this.countLines(this.pos, stop);
    this.pos = stop;
  }

  /** Napis w potrójnym cudzysłowie (blok tekstu Javy, surowy napis Kotlina): bez ucieczek, przez wiele linii. */
  private textBlock(): void {
    const line = this.line;
    const start = this.pos + 3;
    const end = this.src.indexOf('"""', start);
    const stop = end < 0 ? this.src.length : end;
    this.tokens.push({ kind: "string", value: this.src.slice(start, stop), line });
    this.countLines(this.pos, stop);
    this.pos = end < 0 ? stop : stop + 3;
  }

  /** Napis albo znak do cudzysłowu zamykającego; koniec linii też go kończy (niezamknięty napis w złym kodzie). */
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

/** Cyfry są częścią identyfikatora, a liczba to identyfikator od cyfry: ekstraktorom wystarcza, że nie jest napisem. */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

/**
 * Indeks tokenu za nawiasem zamykającym ten, który otwiera token `open`; dla nawiasu, który się nie zamyka, `open + 1`
 * (pusta zawartość), żeby kod niedomkniętego pliku nie ciągnął się do jego końca. Pary liczy się raz na listę tokenów
 * (`matchingBrackets`), bo ekstraktory pytają o tysiące nawiasów jednego pliku, a plik jest z repo (§8).
 */
export function closingIndex(tokens: readonly Token[], open: number): number {
  let pairs = PAIRS.get(tokens);
  if (!pairs) {
    pairs = matchingBrackets(tokens);
    PAIRS.set(tokens, pairs);
  }
  return pairs.get(open) ?? open + 1;
}

/** Pary nawiasów listy tokenów policzone raz, osobno dla każdego rodzaju nawiasu. */
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
