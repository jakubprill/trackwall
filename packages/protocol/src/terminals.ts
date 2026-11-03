import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * A folder terminal (ADR-185): the user's own shell in a repo root or a task's worktree, in a PTY the daemon owns and the
 * UI shows like a session terminal. The request names the place by its ids, never by a path, and the daemon chooses the
 * shell from its own environment; there is no MCP tool for it.
 */

export const TerminalId = z.uuid();

/** Where a folder terminal works: a repo root (`task: null`) or the worktree of a task of that repo. */
export const TerminalPlace = z.object({ repo: RepoId, task: TaskId.nullable() }).strict();
export type TerminalPlace = z.infer<typeof TerminalPlace>;

export const FolderTerminal = z.object({
  id: TerminalId,
  repo: RepoId,
  task: TaskId.nullable(),
  run: RunState,
});
export type FolderTerminal = z.infer<typeof FolderTerminal>;

/** More live folder terminals than a person can watch is a script, not a person. */
export const MAX_FOLDER_TERMINALS = 16;

const endpoint = apiEndpoints("terminals");

export const terminalsApi = {
  /**
   * The place's terminal: the live one when there is one, otherwise a new shell there. `not_found` for a repo or task
   * that is not there, `bad_request` for a task of another repo or above `MAX_FOLDER_TERMINALS`.
   */
  start: endpoint("start", TerminalPlace, FolderTerminal),
  /** Every folder terminal of this daemon, also one whose shell ended and that was not closed yet. */
  list: endpoint("list", z.object({}).strict(), z.array(FolderTerminal)),
  /** Ends the terminal's shell and forgets it; returns once the end is confirmed (`stop_unconfirmed` otherwise). */
  close: endpoint("close", z.object({ terminal: TerminalId }).strict(), Done),
};
