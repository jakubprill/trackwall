import { z } from "zod";
import { TASK_PROMPT_MAX, TASK_TITLE_MAX, TaskApprovals, TaskModel } from "./agents.ts";
import type { McpTool } from "./mcp.ts";
import { GET_CHANGED_ENDPOINTS, GET_REPO, LIST_REPOS, PROPOSE_TASK, REPORT_RESULT, RepoArg, RUN_MISE_TASK } from "./mcp-args.ts";
import { Routine, RoutineEntry, RoutineName } from "./routines.ts";
import { trackwallDirLabel } from "./trackwall-dir.ts";

/**
 * The MCP tool of routines (ADR-173): an agent writes a routine the user asked for; only the user approves and runs it.
 * Part of `mcpTools`.
 */

export const PROPOSE_ROUTINE = "propose_routine";

export const ProposeRoutineResult = z.object({ routine: RoutineEntry });
export type ProposeRoutineResult = z.infer<typeof ProposeRoutineResult>;

export const routineMcpTools = {
  proposeRoutine: {
    name: PROPOSE_ROUTINE,
    readOnly: false,
    destructive: false,
    description:
      "Save a routine: a task the user runs by hand again and again from New task in Trackwall's Sessions view, e.g. " +
      "fetch the new OpenAPI spec, regenerate the client, compile, and report what changed. Use it only when the user " +
      `asks for a routine. It is written to ${trackwallDirLabel("routines")}/<name>.md in the projects folder and runs ` +
      "only after the user approves its content there; saving under an existing name replaces that routine, which then " +
      "waits for approval again (read the file first to keep what still holds). Before you write it, look at the repo " +
      `(${GET_REPO}, its mise tasks, its files) so the prompt names the real files, commands and checks. Put fixed ` +
      "commands (download, generate, compile) into a mise task of the repo, with the user's consent and where the user " +
      `says, and have the prompt run it with ${RUN_MISE_TASK}, so every run does the same steps and the agent only judges ` +
      "the result; tell the user that the routine's approval covers its prompt, not that mise task. Write the prompt so it stands alone, like one for " +
      `${PROPOSE_TASK}: the goal, the steps, how to judge the outcome (what failed and why, which endpoints changed ` +
      `with ${GET_CHANGED_ENDPOINTS} after a commit, whom it affects), and to end with ${REPORT_RESULT}: a short summary ` +
      "for the user with a recommendation, a merge request when the change is safe or what a developer must look at. " +
      "The run never pushes or opens a merge request by itself: the user does that from the task. Never put a secret " +
      "value into a routine; name the environment variable instead. Then tell the user to approve it in Trackwall.",
    args: z
      .object({
        name: RoutineName.describe("lowercase words joined by -, also the file name, e.g. update-orders-client"),
        title: Routine.shape.title.describe(
          `short single-line title for the list and the task it starts, up to ${TASK_TITLE_MAX} characters, e.g. Update the orders API client`,
        ),
        repo: RepoArg.describe(`repo id from ${LIST_REPOS} (the id field): the task of each run works in a worktree of it`),
        prompt: Routine.shape.prompt.describe(`the complete instructions for each run, up to ${TASK_PROMPT_MAX} characters`),
        model: TaskModel.optional().describe("Copilot CLI model id for each run, only when the user named one"),
        approvals: TaskApprovals.optional().describe(
          "ask (the default): each run's agent asks the user before each tool its rules do not allow; auto: only when the " +
            "user said this routine may run without approvals",
        ),
      })
      .strict(),
    result: ProposeRoutineResult,
  },
} satisfies Record<string, McpTool>;
