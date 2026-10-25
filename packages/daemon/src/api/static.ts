import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { isInside } from "../infra/path-inside.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function isUiDir(dir: string | undefined): dir is string {
  return dir !== undefined && existsSync(join(dir, "index.html"));
}

/**
 * Serves the built UI from `dir`. A path outside the directory ends in 404; an unknown path without an extension
 * gets `index.html` (routing on the UI side).
 */
export function serveStatic(dir: string, urlPath: string, res: ServerResponse): void {
  const root = resolve(dir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    notFound(res);
    return;
  }
  let file = resolve(root, `.${decoded}`);
  if (!isInside(root, file)) {
    notFound(res);
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(decoded) !== "") {
      notFound(res);
      return;
    }
    file = join(root, "index.html");
  }
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  // Only files with a hash in the name (Vite: `assets/`), counted relative to the UI directory, not the whole path on disk.
  const immutable = relative(root, file).startsWith(`assets${sep}`);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(file));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}
