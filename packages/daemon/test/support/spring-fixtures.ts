import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The directory of the made-up shop repos (`test/fixtures/spring`, described in its README). */
const SPRING_FIXTURES = join(import.meta.dir, "..", "fixtures", "spring");

/**
 * A fixture repo's files as a path in the repo (with `/`, as in git) → contents, in git's order (bytewise by path):
 * the `readdirSync` order depends on the file system, and a card lists clients in file order.
 */
export function fixtureFiles(repo: string): Record<string, string> {
  const root = join(SPRING_FIXTURES, repo);
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, ...path.split("/")), "utf8")]));
}
