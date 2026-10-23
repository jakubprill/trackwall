/**
 * Wzorce ścieżek w stylu globów: `*` to dowolny ciąg bez `/`, `**` także z `/` (a `**` z ukośnikiem za nim także
 * nic), `?` jeden znak bez `/`. Wystarcza na wzorce workspace npm i pnpm oraz na reguły tagów z `workspace.yaml`; nawiasów `{a,b}`
 * i klas `[…]` nie ma.
 */
export function globToRegExp(pattern: string, opts: { ignoreCase?: boolean } = {}): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; ) {
    const [fragment, length] = token(pattern, i);
    source += fragment;
    i += length;
  }
  return new RegExp(`^${source}$`, opts.ignoreCase ? "i" : "");
}

/** Fragment wyrażenia dla wzorca od pozycji `i` i liczba zużytych znaków wzorca. */
function token(pattern: string, i: number): [string, number] {
  if (pattern.startsWith("**/", i)) return ["(?:.*/)?", 3];
  if (pattern.startsWith("**", i)) return [".*", 2];
  const c = pattern[i] ?? "";
  if (c === "*") return ["[^/]*", 1];
  if (c === "?") return ["[^/]", 1];
  return [c.replace(/[.+^${}()|[\]\\]/g, "\\$&"), 1];
}
