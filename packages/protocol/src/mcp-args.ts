import { RepoId } from "./workspace.ts";

/** Names and arguments the MCP tool contracts of several files share (`mcp.ts`, `mcp-board.ts`). */

export const LIST_REPOS = "list_repos";
export const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);
