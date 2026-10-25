import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS, mcpTools } from "@trackwall/protocol";
import { envKey } from "./env-key.ts";

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
    `- Follow the work with ${mcpTools.waitForSession.name}, ${mcpTools.listSessions.name} and ${mcpTools.getSession.name}: they cover every session and task, also the ones the user started.`,
    "- Tell the user what you delegated, what came back and what needs their decision.",
  ];
}

function repoRole(repo: string): string[] {
  return [
    `You are a main session in the root of the repo \`${repo}\` (its id in Trackwall tools): the user's own working copy.`,
    `- A larger piece of work, work in another repo or work that can run in parallel goes to another agent: propose it with ${mcpTools.proposeTask.name} and follow it with ${mcpTools.waitForSession.name}.`,
    `- ${mcpTools.reportResult.name} is only for task sessions; here you answer the user directly.`,
  ];
}

function taskRole(repo: string, task: string): string[] {
  return [
    `You run the task \`${task}\` in the repo \`${repo}\` (its id in Trackwall tools), in the task's own git worktree on its own branch. The user reviews the task's changes in Trackwall.`,
    "- Work only in this worktree: the repo root and other worktrees belong to the user and to other agents.",
    `- ${mcpTools.runMiseTask.name} runs mise tasks in the repo root, not in this worktree, so it does not test your changes: run builds and tests here yourself.`,
    "- Commit your changes on the task branch. Do not switch branches, push, merge or open pull requests unless the task asks for it.",
    `- Work that belongs to another repo is not yours: propose it with ${mcpTools.proposeTask.name} and say so in your result.`,
    `- When you are done, or stuck and need the user, call ${mcpTools.reportResult.name}: what you did, what is left and what to check. Call it again if the result changes.`,
  ];
}
