import { createHash } from "node:crypto";
import { STORE_FOLDERS, type StoreFolder } from "@trackwall/protocol";
import type { FolderCopies } from "../../infra/named-file-folder.ts";

/**
 * The workspace store's copies of the workspace's own folders (§4.13, ADR-298): `knowledge/`, `routines/`, `board/` and
 * `task-templates/` at the store's root, one file per file of the folder, and `trackwall/` and `copilot/` with the user's
 * settings (ADR-299), each while the user allows it. What a pass changes is
 * worked out here from the store's last commit, by blob id, so a pass with nothing changed reads no file from git.
 */

/** The store's front page, written once when the folders first go in; the user may rewrite it. */
export const STORE_README = "README.md";

/** A file a commit of the store lists, with its blob id. */
export interface StoreEntry {
  path: string;
  oid: string;
}

export interface StoreFolderChanges {
  files: { path: string; content: Buffer }[];
  removed: string[];
  /** The folders with a change, in the order of `STORE_FOLDERS`. */
  folders: StoreFolder[];
}

/** The blob ids of the store's files in its folders, and of its front page, by path; anything deeper is not the daemon's. */
export function keptFiles(entries: readonly StoreEntry[]): Map<string, string> {
  const folders: readonly string[] = STORE_FOLDERS;
  const kept = new Map<string, string>();
  for (const { path, oid } of entries) {
    const parts = path.split("/");
    if (path === STORE_README || (parts.length === 2 && folders.includes(parts[0] ?? ""))) kept.set(path, oid);
  }
  return kept;
}

/**
 * What brings the store from `kept` (`keptFiles`) to `wanted`, each folder's copies: a held file keeps the store's version,
 * and a folder `wanted` does not name is left as it is, so neither a version waiting for approval nor a folder that could
 * not be read takes anything out. The front page goes in with the first change while `readme` is given and the store has none.
 */
export function storeFolderChanges(
  kept: ReadonlyMap<string, string>,
  wanted: ReadonlyMap<StoreFolder, FolderCopies>,
  readme: Buffer | null,
): StoreFolderChanges {
  const changes: StoreFolderChanges = { files: [], removed: [], folders: [] };
  for (const folder of STORE_FOLDERS) {
    const folderCopies = wanted.get(folder);
    if (folderCopies === undefined) continue;
    const { copies, held } = folderCopies;
    const paths = new Set([...copies.map((copy) => copy.file), ...held].map((file) => `${folder}/${file}`));
    const files = copies.flatMap(({ file, bytes }) => {
      const path = `${folder}/${file}`;
      const oid = kept.get(path);
      return oid !== undefined && blobId(bytes, oid) === oid ? [] : [{ path, content: bytes }];
    });
    const removed = [...kept.keys()].filter((path) => path.startsWith(`${folder}/`) && !paths.has(path));
    if (files.length + removed.length === 0) continue;
    changes.files.push(...files);
    changes.removed.push(...removed.sort());
    changes.folders.push(folder);
  }
  if (readme !== null && changes.files.length > 0 && !kept.has(STORE_README)) changes.files.push({ path: STORE_README, content: readme });
  return changes;
}

/** `Keep knowledge, board` while the user allows the folders, `Stop keeping knowledge, board` once they turn them off. */
export function keepMessage(changes: StoreFolderChanges, on: boolean): string {
  return `${on ? "Keep" : "Stop keeping"} ${changes.folders.join(", ")}`;
}

/**
 * git's id of a blob with `content`, in the hash of `like`, an id of the same store: SHA-256 for a store made with
 * `--object-format=sha256`, SHA-1 otherwise.
 */
export function blobId(content: Buffer, like: string): string {
  const hash = createHash(like.length === 64 ? "sha256" : "sha1");
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest("hex");
}

/** The front page: what the store is and where each thing lies, for someone who opens it on the remote. */
export function storeReadme(): Buffer {
  return Buffer.from(
    [
      "# Workspace store",
      "",
      "Trackwall keeps this repo and commits to it; nobody else does, and agents never do. It is a copy: Trackwall reads",
      "everything from the projects folder, never from here, so a change made here is not taken back.",
      "",
      "- `repos/<repo folder>/`: each repo's local config files (`mise.toml`, `mise.local.toml`, `.worktreeinclude`).",
      "- `knowledge/`: the workspace knowledge entries, only in the version you approved.",
      "- `routines/`: the routines, only in the version you approved.",
      "- `board/`: the board items, one file each.",
      "- `task-templates/`: your own task templates.",
      "- `trackwall/`: Trackwall's `workspace.yaml`, in the commits only.",
      "- `copilot/`: your Copilot CLI `settings.json`, `copilot-instructions.md` and `mcp-config.json`, with secrets masked,",
      "  in the commits only (`git show HEAD:copilot/mcp-config.json`).",
      "",
      'Knowledge, routines, the board and the templates are here while "Keep Plan and knowledge in the store" is on in',
      'Settings, the last two folders while "Keep Trackwall and Copilot CLI settings in the store" is.',
      "",
    ].join("\n"),
  );
}
