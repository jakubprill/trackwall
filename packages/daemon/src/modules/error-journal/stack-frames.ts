import { MAX_ERROR_FRAMES } from "@trackwall/protocol";

/**
 * The frames of an error's stack as places in Trackwall's repo (ADR-94): `packages/daemon/src/api/server.ts:68`. The daemon
 * sees its own files as absolute paths when it runs from source and as paths from its package root in the compiled binary
 * (`src/api/server.ts`, `../protocol/src/api.ts`, which `--sourcemap` gives); the UI's frames are addresses of its built
 * chunks, which `ui-source-map.ts` turns back into sources first. A frame outside Trackwall's code (a library, the runtime)
 * is left out: it says nothing about where to fix, and its path may say where the user keeps things.
 */

/** A frame as the stack wrote it. */
export interface RawFrame {
  file: string;
  line: number;
  column: number;
}

/** V8 and Bun: `at fn (file:line:col)` or `at file:line:col`; WebKit (the macOS window): `fn@file:line:col`. */
const V8_FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/;
const WEBKIT_FRAME = /^\s*[^@\s]*@(.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.split(/\r?\n/)) {
    const match = V8_FRAME.exec(line) ?? WEBKIT_FRAME.exec(line);
    if (match?.[1] === undefined) continue;
    frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
  }
  return frames;
}

/** Trackwall's packages and apps whose sources may appear in a stack. */
const PACKAGES = ["daemon", "protocol", "scene", "ui"] as const;

/**
 * A file of a stack as a path in Trackwall's repo, or `null` outside Trackwall's code. `pkg` is the package whose relative
 * paths these are: the compiled daemon writes `src/…` for its own files and `../<package>/src/…` for its neighbours'.
 */
export function repoPath(file: string, pkg: (typeof PACKAGES)[number]): string | null {
  const path = file.replace(/^file:\/\/\/?/, "/").replaceAll("\\", "/");
  if (/(^|\/)node_modules\//.test(path)) return null;
  const inRepo = /(?:^|\/)packages\/([a-z-]+)\/(src\/[^?#]+)/.exec(path);
  if (inRepo?.[1] && isPackage(inRepo[1])) return `packages/${inRepo[1]}/${inRepo[2]}`;
  const neighbour = /^(?:\.\.\/)+([a-z-]+)\/(src\/[^?#]+)$/.exec(path);
  if (neighbour?.[1] && isPackage(neighbour[1])) return `packages/${neighbour[1]}/${neighbour[2]}`;
  if (/^(?:\.\/)?src\/[^?#]+$/.test(path)) return `packages/${pkg}/${path.replace(/^\.\//, "")}`;
  return null;
}

function isPackage(name: string): name is (typeof PACKAGES)[number] {
  return (PACKAGES as readonly string[]).includes(name);
}

/** The frames in Trackwall's code, `path:line`, at most `MAX_ERROR_FRAMES`, without a frame repeated right after itself. */
export function trackwallFrames(
  frames: readonly RawFrame[],
  toRepoPath: (frame: RawFrame) => { path: string; line: number } | null,
): string[] {
  const out: string[] = [];
  for (const frame of frames) {
    const place = toRepoPath(frame);
    if (!place) continue;
    const text = `${place.path}:${place.line}`;
    if (out.at(-1) !== text) out.push(text);
    if (out.length >= MAX_ERROR_FRAMES) break;
  }
  return out;
}
