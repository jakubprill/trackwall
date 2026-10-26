import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS, mcpTools, TASK_MESSAGE_RULE, TASK_PORT_ENV, VERIFY_MISE_TASK } from "@trackwall/protocol";
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
 * Who the session is: the supervisor in the projects folder (`repo: null`, ADR-58), a main session in the repo root
 * (`task: null`) or a task session in the task's worktree.
 */
export interface SessionRole {
  repo: string | null;
  task: string | null;
}

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

function sessionInstructions(version: string, { repo, task }: SessionRole): string {
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
    ...sessionRole({ repo, task }),
    "",
    "## Trackwall tools",
    "",
    MCP_INSTRUCTIONS,
    "",
  ].join("\n");
}

function sessionRole({ repo, task }: SessionRole): string[] {
  if (repo === null) return supervisorRole();
  return task === null ? repoRole(repo) : taskRole(repo, task);
}

function supervisorRole(): string[] {
  return [
    "You are the supervisor: the one session above all others, in the projects folder that holds the user's repos. The user talks to you to plan and follow work across repos.",
    `- You coordinate, you do not change code: hand each piece of work to an agent with ${mcpTools.proposeTask.name}, one proposal per repo with a prompt that stands on its own. The user approves every proposal before it starts.`,
    `- Do not poll the work you delegated: end your turn, and when one of your tasks finishes a turn, reports, gets a verification verdict, errs or exits, or the user rejects a proposal, Trackwall asks you to call ${mcpTools.getUpdates.name}. ${mcpTools.listSessions.name} and ${mcpTools.getSession.name} cover every session and task, also the ones the user started.`,
    `- Steer your tasks with ${mcpTools.sendMessage.name}: a correction, an answer to a task's question, or what another task changed that it must follow. You can message the tasks a supervisor proposed, not the ones the user started; after a few messages without the user, ask the user before you send more.`,
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
    "- Commit your changes on the task branch. Do not switch branches, push, merge or open pull requests unless the task asks for it.",
    `- Work that belongs to another repo is not yours: propose it with ${mcpTools.proposeTask.name} and say so in your result.`,
    `- Before you report that you are done, call ${mcpTools.verifyTask.name} with repo \`${repo}\` and task \`${task}\`: it runs the repo's mise task ${VERIFY_MISE_TASK} in this worktree, and the user sees its verdict in the task's panel. Fix what fails and call it again. If the repo has no mise task ${VERIFY_MISE_TASK}, do not add one (a changed mise config needs the user's trust); say so in your result.`,
    `- When you are done, or stuck and need the user or the session that proposed the task, call ${mcpTools.reportResult.name}: what you did, what is left and what to check, or the question you need answered. Call it again if the result changes.`,
    `- When Trackwall asks you to call ${mcpTools.getMessages.name}, the session that proposed your task has written to you. ${TASK_MESSAGE_RULE}`,
  ];
}
