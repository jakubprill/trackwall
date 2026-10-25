import { basename } from "node:path";

/**
 * The repo identifier from the directory name, computed on every read of the projects folder: lower case without diacritics,
 * other characters outside `[a-z0-9._-]` replaced with `-`, and on a collision with an identifier from `taken`
 * (a repo earlier in order) the suffix `-2`, `-3`…
 */
export function repoIdFor(dir: string, taken: ReadonlySet<string>): string {
  const base =
    basename(dir)
      // NFKD does not decompose `ł` into a letter and a diacritic.
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "")
      .slice(0, 60) || "repo";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
