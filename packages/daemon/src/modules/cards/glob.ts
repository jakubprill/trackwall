/**
 * Wzorce ścieżek w stylu globów: `*` to dowolny ciąg bez `/`, `**` także z `/` (a `**` z ukośnikiem za nim także
 * nic), `?` jeden znak bez `/`. Wystarcza na wzorce workspace npm i pnpm oraz na reguły tagów z `workspace.yaml`;
 * nawiasów `{a,b}` i klas `[…]` nie ma.
 *
 * Bez wyrażeń regularnych: wzorzec workspace pochodzi z repo (niezaufany, §8), a `*a*a*a*a` przełożone na wyrażenie
 * cofa się wielomianowo długo na długiej ścieżce. Programowanie dynamiczne daje czas wzorzec × ścieżka.
 */

type Token = { kind: "literal"; char: string } | { kind: "one" | "segment" | "any" | "dirs" };

export function globMatcher(pattern: string, opts: { ignoreCase?: boolean } = {}): (path: string) => boolean {
  const fold = (s: string) => (opts.ignoreCase ? s.toLowerCase() : s);
  const tokens = tokenize(fold(pattern));
  return (path) => matches(tokens, fold(path));
}

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      tokens.push({ kind: "dirs" });
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      tokens.push({ kind: "any" });
      i += 2;
    } else {
      const char = pattern[i] ?? "";
      tokens.push(char === "*" ? { kind: "segment" } : char === "?" ? { kind: "one" } : { kind: "literal", char });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Czy tokeny od bieżącego do końca pasują do `path` od pozycji `j`, liczone od ostatniego tokenu. Token `dirs`
 * (dwie gwiazdki z ukośnikiem) to nic albo dowolny ciąg zakończony `/`.
 */
function matches(tokens: readonly Token[], path: string): boolean {
  let next = Array.from({ length: path.length + 1 }, (_, j) => j === path.length);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token) next = row(token, path, next);
  }
  return next[0] ?? false;
}

/** Wynik tokenu dla każdej pozycji `path`, z wyniku `next` dla tokenów za nim. */
function row(token: Token, path: string, next: readonly boolean[]): boolean[] {
  const current = new Array<boolean>(path.length + 1).fill(false);
  // Dla `dirs`: czy od `j` jest `/`, za którym pasują tokeny za tym.
  let slashAhead = false;
  for (let j = path.length; j >= 0; j--) {
    const c = path[j];
    if (token.kind === "dirs") {
      slashAhead = c !== undefined && ((c === "/" && (next[j + 1] ?? false)) || slashAhead);
      current[j] = (next[j] ?? false) || slashAhead;
    } else current[j] = step(token, c, j, next, current);
  }
  return current;
}

/** Jeden token na znaku `c` z pozycji `j`; `next` to wynik dla kolejnego tokenu, `current` dla tego od `j + 1`. */
function step(token: Token, c: string | undefined, j: number, next: readonly boolean[], current: readonly boolean[]): boolean {
  const after = next[j + 1] ?? false;
  const stay = current[j + 1] ?? false;
  if (token.kind === "literal") return c === token.char && after;
  if (token.kind === "one") return c !== undefined && c !== "/" && after;
  if (token.kind === "segment") return (next[j] ?? false) || (c !== undefined && c !== "/" && stay);
  return (next[j] ?? false) || (c !== undefined && stay);
}
