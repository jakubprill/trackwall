import type { FileHandle } from "node:fs/promises";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type FolderEntry,
  type FolderEntryKind,
  type FolderListing,
  MAX_DOWNLOAD_BYTES,
  MAX_FOLDER_ENTRIES,
  type PlaceFile,
  type TerminalPlace,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isInside } from "../../infra/path-inside.ts";
import { openRegularFile } from "../../infra/regular-file.ts";

/**
 * The files of a place's folder (§4.23, ADR-187): a read-only list next to its Shell tab and a download of one file, so
 * that a build's JAR, a log or a heap dump reaches the user's computer when the daemon runs in a container. The place
 * comes as ids like a folder terminal's, the path only as names under its folder: no `.` or `..`, no link anywhere on
 * the way, and the resolved path inside the folder's resolved path. Nothing is written, and there is no MCP tool.
 */

export interface FolderFilesDeps {
  /** The folder of a place, as a folder terminal gets it (`not_found` or `bad_request` otherwise). */
  folder: (place: TerminalPlace) => Promise<string>;
}

/** A file to stream out: its name for the download, its size and the open handle the caller closes. */
export interface FileDownload {
  name: string;
  size: number;
  handle: FileHandle;
}

export class FolderFiles {
  readonly #deps: FolderFilesDeps;

  constructor(deps: FolderFilesDeps) {
    this.#deps = deps;
  }

  /** The folder at `path`: folders first, then by name, at most `MAX_FOLDER_ENTRIES`. */
  async list(at: PlaceFile): Promise<FolderListing> {
    const folder = await this.#resolve(at);
    const stat = await lstat(folder);
    if (!stat.isDirectory()) throw new DomainError("bad_request", `${at.path} is not a folder`);
    const dirents = await readdir(folder, { withFileTypes: true });
    const sorted = dirents
      .map((d) => ({ name: d.name, kind: kindOf(d) }))
      .sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || compareNames(a.name, b.name));
    const shown = sorted.slice(0, MAX_FOLDER_ENTRIES);
    const entries = await Promise.all(shown.map((e) => withSize(folder, e)));
    return { path: at.path, entries, truncated: sorted.length > shown.length };
  }

  /** The file at `path`, opened without following a link and at most `MAX_DOWNLOAD_BYTES`. */
  async download(at: PlaceFile): Promise<FileDownload> {
    const file = await this.#resolve(at);
    const name = at.path.split("/").at(-1) ?? "";
    if (name === "") throw new DomainError("bad_request", "name a file to download, not the folder itself");
    const opened = await openRegularFile(file, MAX_DOWNLOAD_BYTES).catch((err: unknown) => {
      throw new DomainError("bad_request", downloadRefusal(err));
    });
    if (!opened) throw new DomainError("not_found", `no file ${at.path}`);
    return { name, ...opened };
  }

  /** The full path of `path` in the place's folder, after every check of the module comment. */
  async #resolve(at: PlaceFile): Promise<string> {
    const root = await this.#deps.folder({ repo: at.repo, task: at.task });
    const names = placeNames(at.path);
    let path = root;
    for (const name of names) {
      path = join(path, name);
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined) throw new DomainError("not_found", `no ${at.path} in this folder`);
      if (stat.isSymbolicLink()) throw new DomainError("bad_request", `${at.path} goes through a link, which is not followed`);
    }
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    if (!isInside(realRoot, realPath)) throw new DomainError("bad_request", `${at.path} is not inside the folder`);
    return path;
  }
}

/**
 * The names of a place path; refuses what could leave the folder or name something else than it says: an empty name,
 * `.`, `..`, a NUL, and on Windows a `\` or `:` (another separator, a drive or an alternate data stream).
 */
export function placeNames(path: string): string[] {
  if (path === "") return [];
  const names = path.split("/");
  const windows = process.platform === "win32";
  for (const name of names) {
    if (name === "" || name === "." || name === ".." || name.includes("\0") || (windows && /[\\:]/.test(name)))
      throw new DomainError("bad_request", `${JSON.stringify(path)} is not a path of names under the folder`);
  }
  return names;
}

function kindOf(d: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FolderEntryKind {
  if (d.isSymbolicLink()) return "link";
  if (d.isDirectory()) return "folder";
  return d.isFile() ? "file" : "other";
}

/** A file's size from `lstat`; an entry that went away meanwhile keeps its kind without a size. */
async function withSize(folder: string, entry: { name: string; kind: FolderEntryKind }): Promise<FolderEntry> {
  if (entry.kind !== "file") return { ...entry, size: null };
  const stat = await lstat(join(folder, entry.name)).catch(() => undefined);
  return { ...entry, size: stat?.isFile() ? stat.size : null };
}

/** By name as a person sorts them: case and numbers (`file2` before `file10`) the way a file manager does. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

function downloadRefusal(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("larger than") ? `${message}; copy it out with docker cp instead` : message;
}
