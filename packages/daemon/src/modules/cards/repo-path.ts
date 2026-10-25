/**
 * File paths in a commit (§4.6): always with `/`, as in git, relative to the repo root, so not through `node:path`,
 * which uses `\` on Windows.
 */

/** The directory of a path in the repo; `""` for the root. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file name without its extension (`src/main/java/a/OrderDto.java` → `OrderDto`). */
export function stemOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

/**
 * The path `rel` relative to directory `dir`, with `.` and `..` resolved; `undefined` when it leaves the repo or is
 * absolute (a Maven module outside the repo is not part of this repo).
 */
export function joinPath(dir: string, rel: string): string | undefined {
  const normalized = rel.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return undefined;
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** The path of file `name` in directory `dir`. */
export function inDir(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Whether `path` lies in directory `dir` or deeper (`dir` `""` is the root, where everything lies). */
export function isUnder(path: string, dir: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

/**
 * Build files without a file of the same kind in any parent directory: the build roots. A deeper file belongs to the
 * root's build only when the root lists it (a module, a workspace package), so a `pom.xml` from test fixtures does not
 * reach the card. Every file checks only its own ancestors, because the tree can have tens of thousands of files.
 */
export function rootFiles(files: readonly string[]): string[] {
  const dirs = new Set(files.map(dirOf));
  return files.filter((file) => {
    for (let dir = dirOf(file); dir !== ""; ) {
      dir = dirOf(dir);
      if (dirs.has(dir)) return false;
    }
    return true;
  });
}
