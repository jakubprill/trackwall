import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Finding JUnit reports in a checkout (ADR-60) without a configuration: the build tools write them next to the code,
 * `target/surefire-reports` and `target/failsafe-reports` (Maven), `build/test-results/<task>` (Gradle), and
 * `junit.xml` (jest-junit, Vitest). The walk is bounded, because a checkout can be huge: it skips hidden directories,
 * `node_modules` and `src` (reports are never there), and inside `target` and `build` enters only the report
 * directories, not the compiled classes. Under Surefire's directory it skips `junitreports`, where TestNG writes a
 * second copy of every result. Symbolic links are not followed, so it stays inside the checkout. Reports older than
 * `since` are counted, not kept, before the report limit applies, so old reports of one module do not crowd out the
 * fresh ones of another.
 */

/** A report file found: its full path, its path relative to the checkout with `/`, size and modification time. */
export interface ReportFile {
  file: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FoundReports {
  files: ReportFile[];
  /** Reports left out because they were written before `since`. */
  earlier: number;
  /** The walk stopped at `MAX_DIRS` directories or `MAX_FILES` reports, so some reports may be missing. */
  truncated: boolean;
}

/** Bounds of one walk: enough for a multi-module Maven or Gradle repo, small enough to answer in a moment. */
const MAX_DIRS = 20_000;
const MAX_FILES = 2000;
const MAX_DEPTH = 10;

const REPORT_FILE = /^(TEST-.+|junit)\.xml$/;
const SKIPPED_DIRS = new Set(["node_modules", "src"]);
/** TestNG's copy of the results Surefire already wrote as `TEST-TestSuite.xml`. */
const DUPLICATE_REPORT_DIRS = new Set(["junitreports"]);
const BUILD_DIRS = new Set(["target", "build"]);
const REPORT_DIRS = new Set(["surefire-reports", "failsafe-reports", "test-results"]);

interface WalkDir {
  dir: string;
  depth: number;
  place: Place;
}

/** The reports under `root` written at or after `sinceMs` (`-Infinity` for all). */
export async function findReportFiles(root: string, sinceMs: number): Promise<FoundReports> {
  const files: ReportFile[] = [];
  let earlier = 0;
  // Breadth first: reports of the top modules come before those of deeply nested ones when a limit cuts the walk.
  const queue: WalkDir[] = [{ dir: root, depth: 0, place: "checkout" }];
  for (let visited = 0; visited < queue.length; visited++) {
    if (visited >= MAX_DIRS) return { files, earlier, truncated: true };
    const next = queue[visited];
    if (next === undefined) break;
    for (const file of await visit(root, next, queue)) {
      if (file.mtimeMs < sinceMs) earlier++;
      else files.push(file);
    }
    if (files.length > MAX_FILES) return { files: files.slice(0, MAX_FILES), earlier, truncated: true };
  }
  return { files, earlier, truncated: false };
}

/** The reports in one directory; its subdirectories the walk enters go to `queue`. */
async function visit(root: string, at: WalkDir, queue: WalkDir[]): Promise<ReportFile[]> {
  const files: ReportFile[] = [];
  for (const entry of await entriesOf(at.dir, at.depth === 0)) {
    const full = join(at.dir, entry.name);
    if (entry.isFile() && REPORT_FILE.test(entry.name)) {
      const info = await stat(full).catch(() => undefined);
      if (info) files.push({ file: full, path: relative(root, full).split(sep).join("/"), size: info.size, mtimeMs: info.mtimeMs });
    } else if (entry.isDirectory() && at.depth < MAX_DEPTH) {
      const place = placeOf(entry.name, at.place);
      if (place !== undefined) queue.push({ dir: full, depth: at.depth + 1, place });
    }
  }
  return files;
}

/** Where a directory of the walk is: in the checkout, in a build directory, or in a report directory under it. */
type Place = "checkout" | "build" | "reports";

/**
 * Where the subdirectory `name` of a directory at `parent` is, or `undefined` when the walk skips it: in a build
 * directory only the report directories, under them everything (Gradle writes `test-results/<task>/`).
 */
function placeOf(name: string, parent: Place): Place | undefined {
  if (name.startsWith(".")) return undefined;
  if (parent === "reports") return DUPLICATE_REPORT_DIRS.has(name) ? undefined : "reports";
  if (parent === "build") return REPORT_DIRS.has(name) ? "reports" : undefined;
  if (SKIPPED_DIRS.has(name)) return undefined;
  return BUILD_DIRS.has(name) ? "build" : "checkout";
}

/**
 * The entries of a directory. The root must be readable (a missing checkout is an error for the caller); a
 * subdirectory that disappears or cannot be read during the walk (a build cleaning up) is left out.
 */
async function entriesOf(dir: string, isRoot: boolean) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) throw err;
    return [];
  }
}
