import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS, mcpTools, TASK_MESSAGE_RULE, TASK_MESSAGE_USES, TASK_PORT_ENV, VERIFY_MISE_TASK } from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";
import type { HandoffFacts } from "./task-handoff.ts";

/**
 * Session instructions (§4.4, ADR-46): an `*.instructions.md` file in the session directory that Copilot CLI loads as a
 * repository instruction, because the daemon adds its directory to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` in the session
 * environment. It changes neither the user's repo nor `~/.copilot`. The content is the session's environment (the
 * Trackwall version and where the user sees the session), its role (the supervisor or a free session in the projects
 * folder, a main session in the repo root or a task session in a worktree) and the shared MCP instruction (`MCP_INSTRUCTIONS`), which
 * Copilot CLI does not take from the MCP server.
 */

/** Copilot CLI 1.0.103 variable with instruction directories separated by commas (checked with `copilot instruction list`). */
const INSTRUCTIONS_DIRS_ENV = "COPILOT_CUSTOM_INSTRUCTIONS_DIRS";
const INSTRUCTIONS_DIR = "instructions";
const INSTRUCTIONS_FILE = "trackwall.instructions.md";

/**
 * Who the session is: the supervisor in the projects folder (ADR-58), which may change code only with
 * `supervisor.changesCode` (ADR-78), a free session in the projects folder (ADR-100), or in a repo a main session in its
 * root, or a task session in the task's worktree, with the task that handed it its work (ADR-143).
 */
export type SessionRole =
  | { kind: "supervisor"; changesCode: boolean }
  | { kind: "free" }
  | { kind: "repo"; repo: string }
  | { kind: "task"; repo: string; task: string; handoff: HandoffFacts | null };

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
  return [
    // `applyTo: "**"`: the instruction applies to every file, i.e. to the whole session, like `.github/instructions` in a repo.
    "---",
    'applyTo: "**"',
    "---",
    "# Working in Trackwall",
    "",
    `Trackwall ${version} started this Copilot CLI session, and its \`trackwall\` MCP server is connected. The user ` +
      `sees this session ${role.kind === "supervisor" ? "in the supervisor panel on the right of every Trackwall view" : "in Trackwall's Sessions view next to their other sessions"}, ` +
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
  if (role.kind === "supervisor") return supervisorRole(role.changesCode);
  if (role.kind === "free") return freeRole();
  return role.kind === "repo" ? repoRole(role.repo) : taskRole(role.repo, role.task, role.handoff);
}

function supervisorRole(changesCode: boolean): string[] {
  const delegate = `hand each piece of work to an agent with ${mcpTools.proposeTask.name}, one proposal per repo with a prompt that stands on its own. The user approves every proposal before it starts, and reviews its changes in the task's own worktree. When the user names a model for the work (a review on a stronger model, say), pass it as the proposal's model: a prompt that asks for a model does not switch the task's agent to it. A task's agent asks the user before its tools unless the proposal's approvals is auto: pass auto when the user said the task may run without approvals, and before proposing work that only reads and reports (an analysis, a review), ask the user whether it may.`;
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
    "- The user reads you in a side panel next to their work, so answer short: the conclusion or the decision you need first, then a few lines or a short list. Leave out what the tools already showed, long tables and repeated output; give details when the user asks for them.",
  ];
}

function freeRole(): string[] {
  return [
    "You are a free session in the projects folder that holds the user's repos, not in one repo: the user started you to work with them on whatever they ask, in any repo or none.",
    "- The repos here are the user's own working copies, and nothing you change in them goes through a review in Trackwall: change only what the user asks for, and tell them which repos you changed. Do not switch a repo's branch, commit, push or merge unless they ask.",
    `- A larger piece of work in one repo, or work that can run in parallel, goes to another agent: propose it with ${mcpTools.proposeTask.name}, so it runs in its own worktree and the user reviews it there. Trackwall asks you to call ${mcpTools.getUpdates.name} when its session finishes a turn or reports, and you steer it with ${mcpTools.sendMessage.name}.`,
    `- You work in no repo of Trackwall, so ${mcpTools.runMiseTask.name}, ${mcpTools.startService.name} and the tools that stop them refuse you; run what you need in the repo's folder yourself, or ask the user.`,
    `- ${mcpTools.reportResult.name} is only for task sessions; here you answer the user directly.`,
  ];
}

function repoRole(repo: string): string[] {
  return [
    `You are a main session in the root of the repo \`${repo}\` (its id in Trackwall tools): the user's own working copy.`,
    `- A larger piece of work, work in another repo or work that can run in parallel goes to another agent: propose it with ${mcpTools.proposeTask.name}. Trackwall asks you to call ${mcpTools.getUpdates.name} when its session finishes a turn or reports, and you steer it with ${mcpTools.sendMessage.name}.`,
    `- ${mcpTools.reportResult.name} is only for task sessions; here you answer the user directly.`,
  ];
}

function taskRole(repo: string, task: string, handoff: HandoffFacts | null): string[] {
  return [
    `You run the task \`${task}\` in the repo \`${repo}\` (its id in Trackwall tools), in the task's own git worktree on its own branch. The user reviews the task's changes in Trackwall.`,
    "- Work only in this worktree: the repo root and other worktrees belong to the user and to other agents.",
    `- Build and test your changes with ${mcpTools.runMiseTask.name} and task \`${task}\`: it runs the repo's mise tasks in this worktree (without task, in the repo root, which does not have your changes). ${mcpTools.waitForMiseTask.name}, ${mcpTools.tail.name} and ${mcpTools.getErrors.name} take the same task. If the mise config of this worktree changed, the user has to trust it in Trackwall first.`,
    `- Run your changes with ${mcpTools.startService.name} and task \`${task}\`: the repo's service starts from this worktree on the task's own port (mise tasks here get it as ${TASK_PORT_ENV.join(" and ")}), next to the one from the repo root; ${mcpTools.callEndpoint.name} and ${mcpTools.stopService.name} take the same task.`,
    "- Commit your changes on the task branch. Do not switch branches, push, merge or open merge requests unless the task asks for it: the user pushes the branch and opens its merge request from Trackwall.",
    `- Work that belongs to another repo is not yours: propose it with ${mcpTools.proposeTask.name} and say so in your result. When that work builds on your change (a caller of an endpoint you changed, a reader of a message or field you changed), commit your change first and then propose it, one proposal per repo: ${mcpTools.findEndpoint.name} and ${mcpTools.whoCalls.name} name the repos that call what you changed. Trackwall tells the new task that your task handed it the work and how to read your changes, so your prompt says what changed in the contract and what the other repo has to do, not how your code does it.`,
    `- Before you report that you are done, call ${mcpTools.verifyTask.name} with repo \`${repo}\` and task \`${task}\`: it runs the repo's mise task ${VERIFY_MISE_TASK} in this worktree, and the user sees its verdict in the task's panel. Fix what fails and call it again. If the repo has no mise task ${VERIFY_MISE_TASK}, do not add one (a changed mise config needs the user's trust); say so in your result.`,
    `- When you are done, or stuck and need the user or the session that proposed the task, call ${mcpTools.reportResult.name}: what you did, what is left and what to check, or the question you need answered. Call it again if the result changes. Your result becomes the description of the task's merge request, which the user opens from Trackwall, so write it for the reviewer.`,
    `- When Trackwall asks you to call ${mcpTools.getMessages.name}, the session that proposed your task has written to you. ${TASK_MESSAGE_RULE}`,
    ...(handoff === null ? [] : handoffLines(handoff)),
  ];
}

/** Where the work a task builds on is (ADR-143), with facts from Trackwall's own list and git, not from the proposer's prompt. */
function handoffLines(handoff: HandoffFacts): string[] {
  const { task, repo, branch } = handoff;
  const from = `the task \`${task}\` in the repo \`${repo}\` (branch \`${branch}\`)`;
  if (handoff.ended)
    return [
      `- Your task was handed to you by ${from}, which the user has ended since, so ${mcpTools.getTaskChanges.name} no longer reads it. Its branch may still be in the repo; ask the user through ${mcpTools.reportResult.name} if your work needs it.`,
    ];
  return [
    `- Your task was handed to you by ${from}: its session proposed your task, which the user approved, and you last read that branch at commit \`${handoff.commit}\`. This worktree was made from the default branch, not from that branch, so it does not have that change. Before you change code that builds on it, read what it changed with ${mcpTools.getTaskChanges.name} and task \`${task}\` (its commits and uncommitted work as they are now; narrow it with paths to the files that define the contract). Build against the contract it changed (an endpoint, a field, a message), not a copy of its code. When Trackwall asks you to call ${mcpTools.getHandoff.name}, and before you report, call it: it says where that branch is now and which files changed since you last read it.`,
    `- A question about that change goes into your ${mcpTools.reportResult.name}: the session of task \`${task}\` reads your result.`,
  ];
}
