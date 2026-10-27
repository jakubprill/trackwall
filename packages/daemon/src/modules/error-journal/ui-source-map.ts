import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import { type RawFrame, repoPath } from "./stack-frames.ts";

/**
 * A frame of the UI's stack as a place in its sources (ADR-94). The built UI is minified chunks under `assets/`, and Vite
 * writes a source map next to each (`build.sourcemap`), which the daemon has, because it serves the UI; so a frame
 * `…/assets/index-abc.js:1:2345` becomes `packages/ui/src/views/repos/RepoView.tsx:42`. Under `vite dev` the frames are
 * already the sources (`/src/…`). The asset name is checked before it reaches the file system, and a map bigger than
 * `MAX_MAP_BYTES` is not read.
 */

const MAX_MAP_BYTES = 32 * 1024 * 1024;
const ASSET = /^\/assets\/([\w.-]+\.js)$/;

/** `uiDir`: the folder the daemon serves the UI from, if any. */
export function uiFramePlace(frame: RawFrame, uiDir: string | undefined): { path: string; line: number } | null {
  const pathname = urlPath(frame.file);
  if (pathname === null) return null;
  const asset = ASSET.exec(pathname)?.[1];
  if (asset === undefined) {
    const path = repoPath(pathname.replace(/^\//, ""), "ui");
    return path ? { path, line: frame.line } : null;
  }
  if (uiDir === undefined) return null;
  const original = originalPosition(join(uiDir, "assets", `${asset}.map`), frame.line, frame.column);
  if (!original) return null;
  const path = repoPath(posix.join("packages/ui/dist/assets", original.source), "ui");
  return path ? { path, line: original.line } : null;
}

/** The path of a frame's address (`http://127.0.0.1:1234/…`, `tauri://localhost/…`), or `null` for anything else. */
function urlPath(file: string): string | null {
  try {
    return new URL(file).pathname;
  } catch {
    return null;
  }
}

/** The fields of a Source Map v3 file the lookup needs. */
const SourceMap = z.object({ sources: z.array(z.string()), mappings: z.string() });
type SourceMap = z.infer<typeof SourceMap>;

function readMap(file: string): SourceMap | null {
  try {
    if (statSync(file).size > MAX_MAP_BYTES) return null;
    const parsed = SourceMap.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The source and line (both from 1) of a generated position (line from 1, column from 1, as stacks give them), from the
 * map's `mappings` (Source Map v3): the last segment of that line that starts at or before the column.
 */
function originalPosition(mapFile: string, line: number, column: number): { source: string; line: number } | null {
  const map = readMap(mapFile);
  if (!map) return null;
  return lookup(map, line, column);
}

export function lookup(map: SourceMap, line: number, column: number): { source: string; line: number } | null {
  const lines = map.mappings.split(";").slice(0, line);
  // Source, original line and original column are relative across the whole mappings, so every line before is decoded.
  const state = { source: 0, line: 0, column: 0 };
  let found: { source: number; line: number } | null = null;
  lines.forEach((text, index) => {
    const last = index === line - 1;
    let generatedColumn = 0;
    for (const fields of segments(text)) {
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue;
      state.source += fields[1] ?? 0;
      state.line += fields[2] ?? 0;
      state.column += fields[3] ?? 0;
      if (last && generatedColumn <= column - 1) found = { source: state.source, line: state.line };
    }
  });
  return toOriginal(map, found);
}

function segments(line: string): number[][] {
  return line.split(",").flatMap((segment) => (segment === "" ? [] : [decodeVlq(segment)]));
}

function toOriginal(map: SourceMap, found: { source: number; line: number } | null): { source: string; line: number } | null {
  const source = found ? map.sources[found.source] : undefined;
  return found && source !== undefined ? { source, line: found.line + 1 } : null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit === -1) return values;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}
