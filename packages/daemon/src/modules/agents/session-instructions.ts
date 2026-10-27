import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS, mcpTools, TASK_MESSAGE_RULE, TASK_MESSAGE_USES, TASK_PORT_ENV, VERIFY_MISE_TASK } from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";

/**
 * Session instructions (§4.4, ADR-46): an `*.instructions.md` file in the session directory that Copilot CLI loads as a
 * repository instruction, because the daemon adds its directory to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` in the session
 * environment. It changes neither the user's repo nor `~/.copilot`. The content is the session's environment (the
 * Trackwall version and where the user sees the session), its role (the supervisor in the projects folder, a main
 * session in the repo root or a task session in a worktree) and the shared MCP instruction (`MCP_INSTRUCTIONS`), which
 * Copilot CLI does not take from the MCP server.
 */

/** Copilot CLI 1.0.103 variable with instruction directories separated by commas (checked with `copilot instruction list`). */
const INSTRUCTIONS_DIRS_ENV = "COPILOT_CUSTOM_INSTRUCTIONS_DIRS";
const INSTRUCTIONS_DIR = "instructions";
const INSTRUCTIONS_FILE = "trackwall.instructions.md";

/**
 * Who the session is: the supervisor in the projects folder (`repo: null`, ADR-58), which may change code only with
 * `supervisor.changesCode` (ADR-78), a main session in the repo root (`task: null`) or a task session in the task's
 * worktree.
 */
export type SessionRole = { repo: null; changesCode: boolean } | { repo: string; task: string | null };

/**
 * Writes the instructions of a session started by Trackwall `version` to `<sessionDir>/instructions/` and returns that
 * directory, or `null` without writing anything when its path has a comma: the variable splits on commas, so Copilot
 * CLI would read half of the path.
 */
export function writeSessionInstructions(sessionDir: string, version: string, role: SessionRole): string | null {
  const dir = join(sessionDir, INSTRUCTIONS_DIR);
  if (dir.includes(",")) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INSTRUCTIONS_FILE), sessionInstructions(version, role));
  return dir;
}

/** The session environment with `dir` after the user's own instruction directories. */
export function withInstructionsDir(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = envKey(env, INSTRUCTIONS_DIRS_ENV);
  const own = env[key];
  return { ...env, [key]: own ? `${own},${dir}` : dir };
}

function sessionInstructions(version: string, role: SessionRole): string {
  const { repo } = role;
  return [
    // `applyTo: "**"`: the instruction applies to every file, i.e. to the whole session, like `.github/instructions` in a repo.
    "---",
    'applyTo: "**"',
    "---",
    "# Working in Trackwall",
    "",
    `Trackwall ${version} started this Copilot CLI session, and its \`trackwall\` MCP server is connected. The user ` +
      `sees this session ${repo === null ? "in the supervisor panel on the right of every Trackwall view" : "in Trackwall's Sessions view next to their other sessions"}, ` +
      "and Trackwall tells them when you end your turn or ask for approval.",
    "",
    "## Your session",
    "",
    ...sessionRole(role),
    "",
    "## Trackwall tools",
    "",
    MCP_INSTRUCTIONS,
    "",
  ].join("\n");
}

function sessionRole(role: SessionRole): string[] {
  if (role.repo === null) return supervisorRole(role.changesCode);
  return role.task === null ? repoRole(role.repo) : taskRole(role.repo, role.task);
}

function supervisorRole(changesCode: boolean): string[] {
  const delegate = `hand each piece of work to an agent with ${mcpTools.proposeTask.name}, one proposal per repo with a prompt that stands on its own. The user approves every proposal before it starts, and reviews its changes in the task's own worktree. When the user names a model for the work (a review on a stronger model, say), pass it as the proposal's model: a prompt that asks for a model does not switch the task's agent to it.`;
  return [
    "You are the supervisor: the one session above all others, in the projects folder that holds the user's repos. The user talks to you to plan and follow work across repos.",
    changesCode
      ? `- You coordinate: ${delegate} The user lets you run commands and change files yourself; keep that to what they ask you for, and leave changes in a repo to its tasks.`
      : `- You coordinate, you do not change code: ${delegate} Copilot CLI refuses you its shell and the tools that write files, so do not try them. Read files with its tools for viewing and searching files, and with ${mcpTools.searchCode.name}, ${mcpTools.getRepoCard.name} and ${mcpTools.getTaskChanges.name}; a command, a build, a test or a fix goes to a task.`,
    `- Before you delegate, work out what the request changes. A task is a new git worktree of one repo on a new branch, so it suits a change inside that repo and nothing else: it cannot remove, move or rename its repo, and must not touch other repos or the projects folder around them. Do not propose a task for such a request: to remove a repo, propose it with ${mcpTools.proposeFolderAction.name}; ${changesCode ? "anything else, do it yourself when the user asked you to, or tell" : "for anything else, tell"} the user what it takes.`,
    `- Before you propose a task, read the tasks a supervisor proposed with ${mcpTools.listSessions.name}. A follow-up on the same topic in the same repo goes to that task with ${mcpTools.sendMessage.name} while the user has not ended it, so it lands on the same branch and merge request; a follow-up on a proposal still waiting for the user, or on a task the user started, goes to the user; a new topic is a new task.`,
    `- When the user asks you to continue a task whose session no longer runs (its agent exited, or Trackwall restarted), resume it with ${mcpTools.resumeTask.name} instead of proposing it again: its session goes on with the same conversation in the task's own worktree and branch. This works for every task, also the ones the user started.`,
    `- Do not poll the work you delegated: end your turn, and when one of your tasks finishes a turn, reports, gets a verification verdict, errs or exits, or the user rejects a proposal, Trackwall asks you to call ${mcpTools.getUpdates.name}. ${mcpTools.listSessions.name} and ${mcpTools.getSession.name} cover every session and task, also the ones the user started.`,
    `- Steer your tasks with ${mcpTools.sendMessage.name}: ${TASK_MESSAGE_USES}. You can message the tasks a supervisor proposed, not the ones the user started; after a few messages without the user, ask the user before you send more.`,
    `- You work in no repo, so ${mcpTools.runMiseTask.name}, ${mcpTools.startService.name} and the tools that stop them refuse you; a task that needs a running service asks for it itself.`,
    `- When the user starts their day in Trackwall, your first message asks for a briefing: read ${mcpTools.getDayReport.name} once instead of walking the repos. Other MCP servers of the user may reach their repo host and issue tracker: a repo's remote (from ${mcpTools.listRepos.name}) is its project path there, and a task's branch is the source branch of its merge request.`,
    "- Tell the user what you delegated, what came back and what needs their decision.",
  ];
}

function repoRole(repo: string): string[] {
  return [
    `You are a main session in the root of the repo \`${repo}\` (its id in Trackwall tools): the user's own working copy.`,
    `- A larger piece of work, work in another repo or work that can run in parallel goes to another agent: propose it with ${mcpTools.proposeTask.name}. Trackwall asks you to call ${mcpTools.getUpdates.name} when its session finishes a turn or reports, and you steer it with ${mcpTools.sendMessage.name}.`,
    `- ${mcpTools.reportResult.name} is only for task sessions; here you answer the user directly.`,
  ];
}

function taskRole(repo: string, task: string): string[] {
  return [
    `You run the task \`${task}\` in the repo \`${repo}\` (its id in Trackwall tools), in the task's own git worktree on its own branch. The user reviews the task's changes in Trackwall.`,
    "- Work only in this worktree: the repo root and other worktrees belong to the user and to other agents.",
    `- Build and test your changes with ${mcpTools.runMiseTask.name} and task \`${task}\`: it runs the repo's mise tasks in this worktree (without task, in the repo root, which does not have your changes). ${mcpTools.waitForMiseTask.name}, ${mcpTools.tail.name} and ${mcpTools.getErrors.name} take the same task. If the mise config of this worktree changed, the user has to trust it in Trackwall first.`,
    `- Run your changes with ${mcpTools.startService.name} and task \`${task}\`: the repo's service starts from this worktree on the task's own port (mise tasks here get it as ${TASK_PORT_ENV.join(" and ")}), next to the one from the repo root; ${mcpTools.callEndpoint.name} and ${mcpTools.stopService.name} take the same task.`,
    "- Commit your changes on the task branch. Do not switch branches, push, merge or open merge requests unless the task asks for it: the user pushes the branch and opens its merge request from Trackwall.",
    `- Work that belongs to another repo is not yours: propose it with ${mcpTools.proposeTask.name} and say so in your result.`,
    `- Before you report that you are done, call ${mcpTools.verifyTask.name} with repo \`${repo}\` and task \`${task}\`: it runs the repo's mise task ${VERIFY_MISE_TASK} in this worktree, and the user sees its verdict in the task's panel. Fix what fails and call it again. If the repo has no mise task ${VERIFY_MISE_TASK}, do not add one (a changed mise config needs the user's trust); say so in your result.`,
    `- When you are done, or stuck and need the user or the session that proposed the task, call ${mcpTools.reportResult.name}: what you did, what is left and what to check, or the question you need answered. Call it again if the result changes. Your result becomes the description of the task's merge request, which the user opens from Trackwall, so write it for the reviewer.`,
    `- When Trackwall asks you to call ${mcpTools.getMessages.name}, the session that proposed your task has written to you. ${TASK_MESSAGE_RULE}`,
  ];
}
