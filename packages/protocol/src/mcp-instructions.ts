import { TRACKWALL_DOCS_LLMS_URL, TRACKWALL_DOCS_URL } from "./docs-site.ts";
import { trackwallLink } from "./links.ts";
import { mcpTools } from "./mcp.ts";

/**
 * The MCP instruction: how an agent works with Trackwall (ADR-46). The MCP server announces it in `initialize`
 * (`instructions`), and the daemon adds it to the session instructions of every Copilot CLI session, because Copilot
 * CLI takes `instructions` only from servers on its own allowlist. Tool descriptions say what a tool returns; this says
 * in which order and when to reach for which one. Tool names come from `mcpTools`, so a rename leaves no stale name
 * here, and a test requires every tool to be mentioned.
 */

const {
  listRepos,
  getRepo,
  getRepoCard,
  tail,
  getErrors,
  searchCode,
  whoCalls,
  subgraphFor,
  findEndpoint,
  listSessions,
  getSession,
  getTaskDiff,
  proposeTask,
  reportResult,
  waitForSession,
  runMiseTask,
  stopMiseTask,
  waitForMiseTask,
  listRunningMiseTasks,
  startService,
  stopService,
  listServices,
  callEndpoint,
} = mcpTools;

export const MCP_INSTRUCTIONS = [
  "Trackwall is the user's local workbench for the git repos in their projects folder: it syncs them, reads their build " +
    "files and code into repo cards and a graph of connections between apps, runs mise tasks and Copilot CLI sessions. " +
    `Its tools give you that knowledge. ${runMiseTask.name} and ${stopMiseTask.name} start and stop mise tasks, ` +
    `${startService.name} and ${stopService.name} start and stop services, ` +
    `${proposeTask.name} and ${reportResult.name} record text for the user, and no tool edits repo files or configuration directly.`,
  "",
  "How to work with it:",
  `- Find repos: ${listRepos.name} (narrow it with tags such as java, bff or frontend) gives the repo ids the other tools ` +
    `take. ${getRepo.name} adds the README, recent commits and mise tasks.`,
  `- Understand a repo: ${getRepoCard.name} lists what it provides (packages, Spring Boot apps, HTTP endpoints, DTOs) and ` +
    "consumes (packages, HTTP clients), each fact with file and line. Start there instead of reading build files, then " +
    "open the files it points to.",
  `- Find code across repos: ${searchCode.name} searches the latest commit of many repos at once, not uncommitted ` +
    "changes (narrow with tags, repos and paths); prefer it to walking directories one repo at a time.",
  `- Before you change an endpoint, a DTO, a package or a config address, check whom it affects: ${findEndpoint.name} ` +
    `shows who calls an endpoint, ${whoCalls.name} which repos depend on a repo, ${subgraphFor.name} its neighbourhood. ` +
    "Connections with low or medium confidence are hints: confirm them in the code. Name the affected repos in your result.",
  `- Diagnose a failure: ${getErrors.name} gives the errors from the logs of all mise tasks with their stack traces and ` +
    `root cause; ${tail.name} reads the log of one mise task (${getRepo.name} lists them), from an error on with sinceSeq ` +
    "one less than its seq. In both, pass nextSeq as sinceSeq to get only what is new.",
  `- Build, test or run a service: ${runMiseTask.name} runs a mise task listed by ${getRepo.name} in the repo root, ` +
    "or with task in that task's worktree, which has the task's changes (a task session passes its own task); " +
    `${waitForMiseTask.name} waits for its exit code and ${tail.name} gives its output, with the same task; ` +
    `${listRunningMiseTasks.name} shows what already runs. Stop long-running tasks with ${stopMiseTask.name} when ` +
    "you no longer need them.",
  `- Try a change against the running system: ${startService.name} starts a repo's service (its mise task dev) with ` +
    `the services it calls, dependencies first, and waits until its port answers; ${callEndpoint.name} sends an HTTP ` +
    "request to it and returns the response with the errors every service logged meanwhile, so a failure downstream " +
    `shows too. ${listServices.name} shows the services and their ports; stop what you started with ${stopService.name}.`,
  `- Hand work to another agent, e.g. a change in another repo: ${proposeTask.name} with a prompt that stands on its own; ` +
    `the user approves, edits or rejects it in Trackwall. Then call ${waitForSession.name} with the task id: it returns ` +
    "when the proposal is rejected (with the user's reason, if they gave one) or the task's session needs someone (finished " +
    "its turn, asks for approval, hit an error), goes " +
    `stale or exits; when it times out (still pending, starting or working), call it again. ${getSession.name} shows ` +
    `the task's changed files and ${getTaskDiff.name} their diff (narrow it with paths): review it before you tell the ` +
    "user the work is done. Propose related tasks together, so the user can review them as one plan.",
  `- ${listSessions.name} shows the Copilot CLI sessions and tasks Trackwall runs (caller is your own session); a session ` +
    `that runs a task ends its work with ${reportResult.name}.`,
  `- Point the user at a repo, session or task in your answer with a link: ${trackwallLink("repo", "<repo id>")}, ` +
    `${trackwallLink("session", "<session id>")} or ${trackwallLink("task", "<task id>")} (also for a task proposal) ` +
    "opens it in Trackwall when clicked. A link only shows it, it never runs anything.",
  `- When you or the user are unsure what Trackwall can do or how a feature works, look it up in the documentation (${TRACKWALL_DOCS_URL}; ` +
    `${TRACKWALL_DOCS_LLMS_URL} lists its pages) instead of guessing; it follows the development version, so a feature ` +
    "there may be newer than the running Trackwall.",
].join("\n");
