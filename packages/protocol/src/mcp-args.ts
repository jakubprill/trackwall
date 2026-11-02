import { RepoId } from "./workspace.ts";

/** Names and arguments the MCP tool contracts of several files share (`mcp.ts`, `mcp-board.ts`, `mcp-routines.ts`). */

export const LIST_REPOS = "list_repos";
export const GET_REPO = "get_repo";
export const GET_CHANGED_ENDPOINTS = "get_changed_endpoints";
export const PROPOSE_TASK = "propose_task";
export const PROPOSE_CHANGE = "propose_change";
export const REPORT_RESULT = "report_result";
export const RUN_MISE_TASK = "run_mise_task";
export const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);
