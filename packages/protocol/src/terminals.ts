import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * A folder terminal (ADR-185): the user's own shell in the projects folder, a repo root or a task's worktree, in a PTY the daemon owns and the
 * UI shows like a session terminal. The request names the place by its ids, never by a path, and the daemon chooses the
 * shell from its own environment; there is no MCP tool for it.
 */

export const TerminalId = z.uuid();

/**
 * Where a folder terminal works: the projects folder (`repo: null, task: null`), a repo root (`task: null`) or the
 * worktree of a task of that repo. A task always names its repo.
 */
const placeShape = { repo: RepoId.nullable(), task: TaskId.nullable() };

function namesTaskWithRepo(place: { repo: string | null; task: string | null }): boolean {
  return place.task === null || place.repo !== null;
}

const TASK_NEEDS_REPO = { message: "a task's place names its repo", path: ["repo"] };

export const TerminalPlace = z.object(placeShape).strict().refine(namesTaskWithRepo, TASK_NEEDS_REPO);
export type TerminalPlace = z.infer<typeof TerminalPlace>;

/** The place of the projects folder: every repo of the workspace under one folder (in a dev container, its volume). */
export const PROJECTS_FOLDER_PLACE: TerminalPlace = { repo: null, task: null };

export const FolderTerminal = z.object({
  id: TerminalId,
  repo: RepoId.nullable(),
  task: TaskId.nullable(),
  run: RunState,
});
export type FolderTerminal = z.infer<typeof FolderTerminal>;

/** More folder terminals, ended ones too, than a person can watch is a script, not a person; each keeps a screen in memory. */
export const MAX_FOLDER_TERMINALS = 16;

/**
 * A file or folder under a place, as a path relative to the place's folder with `/` between names (`""` is the folder
 * itself). The daemon refuses `.` and `..`, an empty name and a link anywhere on the way (ADR-188).
 */
export const PlacePath = z.string().max(4096);

/** What is at a path in a place's folder (`terminals/files`, `terminals/download`). */
export const PlaceFile = z
  .object({ ...placeShape, path: PlacePath })
  .strict()
  .refine(namesTaskWithRepo, TASK_NEEDS_REPO);
export type PlaceFile = z.infer<typeof PlaceFile>;

/** A link is shown but never followed: it may point anywhere, out of the place too. */
export const FolderEntryKind = z.enum(["folder", "file", "link", "other"]);
export type FolderEntryKind = z.infer<typeof FolderEntryKind>;

export const FolderEntry = z.object({
  name: z.string(),
  kind: FolderEntryKind,
  /** Bytes of a file; `null` for anything else. */
  size: z.number().int().nonnegative().nullable(),
});
export type FolderEntry = z.infer<typeof FolderEntry>;

/** More entries than this in one folder are cut (`truncated`): a list to browse, not an index (`node_modules`). */
export const MAX_FOLDER_ENTRIES = 2000;
/** A download is held in the page's memory before it is saved; larger files go out with `docker cp`. */
export const MAX_DOWNLOAD_BYTES = 1024 ** 3;

export const FolderListing = z.object({
  path: PlacePath,
  /** Folders first, then by name. */
  entries: z.array(FolderEntry),
  truncated: z.boolean(),
});
export type FolderListing = z.infer<typeof FolderListing>;

/**
 * `POST` with a `PlaceFile` body: the file's bytes as they are (`application/octet-stream`), not `{ ok, data }`; an error
 * comes as the usual `{ ok: false, error }` with its status. Behind the daemon token like every action.
 */
export const DOWNLOAD_PATH = "/api/terminals/download";

const endpoint = apiEndpoints("terminals");

export const terminalsApi = {
  /**
   * The place's terminal: the live one when there is one, otherwise a new shell there. `not_found` for a repo or task
   * that is not there, `bad_request` for a task of another repo, for the projects folder while none is set, or above
   * `MAX_FOLDER_TERMINALS`.
   */
  start: endpoint("start", TerminalPlace, FolderTerminal),
  /** Every folder terminal of this daemon, also one whose shell ended and that was not closed yet. */
  list: endpoint("list", z.object({}).strict(), z.array(FolderTerminal)),
  /** Ends the terminal's shell and forgets it; returns once the end is confirmed (`stop_unconfirmed` otherwise). */
  close: endpoint("close", z.object({ terminal: TerminalId }).strict(), Done),
  /** The folder at `path` in the place, read only (ADR-188); `bad_request` for a path that is not a folder of it. */
  files: endpoint("files", PlaceFile, FolderListing),
};
