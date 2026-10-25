/**
 * Glob-style path patterns: `*` is any string without `/`, `**` also with `/` (and `**` followed by a slash also
 * nothing), `?` one character other than `/`. Enough for npm and pnpm workspace patterns and the tag rules from
 * `workspace.yaml`; there are no `{a,b}` braces or `[…]` classes.
 *
 * No regular expressions: a workspace pattern comes from the repo (untrusted, §8), and `*a*a*a*a` turned into a regular
 * expression backtracks for polynomially long on a long path. Dynamic programming takes pattern × path time.
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
 * Whether the tokens from the current one to the end match `path` from position `j`, computed from the last token. The
 * `dirs` token (two asterisks with a slash) is nothing or any string ending in `/`.
 */
function matches(tokens: readonly Token[], path: string): boolean {
  let next = Array.from({ length: path.length + 1 }, (_, j) => j === path.length);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token) next = row(token, path, next);
  }
  return next[0] ?? false;
}

/** A token's result for every position of `path`, from the `next` result for the tokens after it. */
function row(token: Token, path: string, next: readonly boolean[]): boolean[] {
  const current = new Array<boolean>(path.length + 1).fill(false);
  // For `dirs`: whether from `j` there is a `/` followed by a match of the tokens after this one.
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

/** One token on character `c` at position `j`; `next` is the result for the next token, `current` for this one from `j + 1`. */
function step(token: Token, c: string | undefined, j: number, next: readonly boolean[], current: readonly boolean[]): boolean {
  const after = next[j + 1] ?? false;
  const stay = current[j + 1] ?? false;
  if (token.kind === "literal") return c === token.char && after;
  if (token.kind === "one") return c !== undefined && c !== "/" && after;
  if (token.kind === "segment") return (next[j] ?? false) || (c !== undefined && c !== "/" && stay);
  return (next[j] ?? false) || (c !== undefined && stay);
}
