import type { JavaException, JavaFrame } from "./java-stack-trace.ts";

/**
 * The frames of a stack trace found among a repo's tracked files (ADR-222): a frame's package and file name give the end
 * of its path (`com.example.shop.Order` in `Order.java` ends in `com/example/shop/Order.java`), and only paths from the
 * repo's own list (`git ls-files`) are ever named. A path the trace itself carries is never used, so a pasted trace
 * cannot point the agent, or the daemon, at a file outside the repo.
 */

/** A frame of the trace with the tracked files it may be in: several when modules of the repo have the same class. */
export interface RepoFrame {
  /** The exception's index in the parsed trace. */
  exception: number;
  frame: JavaFrame;
  paths: string[];
}

/** At most this many frames are listed, and at most this many paths for one frame: enough to start, short enough to read. */
const REPO_FRAMES_MAX = 30;
const PATHS_PER_FRAME_MAX = 3;

/** The extensions of the sources the daemon lists for a trace: Java frames name `.java` files. */
export const STACK_TRACE_SOURCE_GLOBS = ["**/*.java"] as const;
/** The output of `git ls-files` read for a trace: about 50,000 paths, more than a repo of one team has. */
export const STACK_TRACE_LIST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The frames that name a tracked file, in the trace's order, without a frame repeated right after itself (recursion,
 * the same place in a cause), up to `REPO_FRAMES_MAX`.
 */
export function repoFrames(exceptions: readonly JavaException[], tracked: readonly string[]): RepoFrame[] {
  const byName = filesByName(tracked);
  const out: RepoFrame[] = [];
  let last = "";
  for (const [exception, { frames }] of exceptions.entries()) {
    for (const frame of frames) {
      const paths = framePaths(frame, byName);
      const place = `${exception}:${paths[0]}:${frame.line}`;
      if (paths.length === 0 || place === last) continue;
      last = place;
      out.push({ exception, frame, paths });
      if (out.length >= REPO_FRAMES_MAX) return out;
    }
  }
  return out;
}

function filesByName(tracked: readonly string[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const path of tracked) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const list = byName.get(name);
    if (list) list.push(path);
    else byName.set(name, [path]);
  }
  return byName;
}

/** The tracked files whose path ends in the frame's package and file name. */
function framePaths(frame: JavaFrame, byName: ReadonlyMap<string, readonly string[]>): string[] {
  if (frame.file === null) return [];
  const ending = `${packagePath(frame.className)}${frame.file}`;
  const candidates = byName.get(frame.file) ?? [];
  return candidates.filter((path) => path === ending || path.endsWith(`/${ending}`)).slice(0, PATHS_PER_FRAME_MAX);
}

/** `com.example.shop.Order$Line` → `com/example/shop/`; a class in the default package has none. */
function packagePath(className: string): string {
  const dot = className.lastIndexOf(".");
  return dot < 0 ? "" : `${className.slice(0, dot).replaceAll(".", "/")}/`;
}
