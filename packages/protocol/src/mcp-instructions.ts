import { TRACKWALL_DOCS_LLMS_URL, TRACKWALL_DOCS_URL } from "./docs-site.ts";
import { trackwallLink } from "./links.ts";
import { mcpTools, TASK_MESSAGE_USES } from "./mcp.ts";

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
  getTestResults,
  searchCode,
  whoCalls,
  subgraphFor,
  findEndpoint,
  listSessions,
  getSession,
  getDayReport,
  getTaskChanges,
  getChangedEndpoints,
  proposeTask,
  proposeFolderAction,
  listItems,
  getItem,
  createItem,
  updateItem,
  reportResult,
  getReviewComments,
  sendMessage,
  resumeTask,
  getMessages,
  getUpdates,
  getHandoff,
  waitForSession,
  runMiseTask,
  stopMiseTask,
  waitForMiseTask,
  listRunningMiseTasks,
  verifyTask,
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
    `${proposeTask.name}, ${proposeFolderAction.name}, ${createItem.name}, ${updateItem.name} and ${reportResult.name} record text for the user, and no tool edits repo files or configuration directly.`,
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
    `shows which endpoints of other repos call an endpoint and which it calls, ${whoCalls.name} which repos depend on a repo, ` +
    `${subgraphFor.name} its neighbourhood. In a task, after you commit, ${getChangedEndpoints.name} lists the endpoints ` +
    "your commits changed with the repos that call them. " +
    "Connections with low or medium confidence are hints: confirm them in the code. Name the affected repos in your result.",
  `- Look for an endpoint with ${findEndpoint.name} first: pass the path or URL as you have it, or words for what it does. ` +
    `When it finds nothing, the repo may build its routes in a way the cards do not read: ${searchCode.name} for a fixed ` +
    "part of the path, then open the controller or the OpenAPI spec it finds.",
  `- Diagnose a failure: ${getErrors.name} gives the errors from the logs of all mise tasks with their stack traces and ` +
    `root cause; ${tail.name} reads the log of one mise task (${getRepo.name} lists them), from an error on with sinceSeq ` +
    "one less than its seq. In both, pass nextSeq as sinceSeq to get only what is new.",
  `- Build, test or run a service: ${runMiseTask.name} runs a mise task listed by ${getRepo.name} in the repo root, ` +
    "or with task in that task's worktree, which has the task's changes (a task session passes its own task); " +
    `${waitForMiseTask.name} waits for its exit code and ${tail.name} gives its output, with the same task; ` +
    `${getTestResults.name} then tells which tests failed and why, from the build's JUnit reports (pass the run's startedAt as since); ` +
    `${listRunningMiseTasks.name} shows what already runs. Stop long-running tasks with ${stopMiseTask.name} when ` +
    "you no longer need them.",
  `- Check that a task's changes pass: ${verifyTask.name} runs the repo's mise task test in the task's worktree and ` +
    "returns one verdict with the first failed tests and log errors; the user sees the same result in the task's panel. " +
    "Call it after your last change, before you report the result.",
  `- Try a change against the running system: ${startService.name} starts a repo's service (its mise task dev) with ` +
    `the services it calls, dependencies first, and waits until its port answers; ${callEndpoint.name} sends an HTTP ` +
    "request to it and returns the response with the errors every service logged meanwhile, so a failure downstream " +
    `shows too. With task, the service runs from that task's worktree on the task port, next to the one from the repo root. ` +
    `${listServices.name} shows the services and their ports; stop what you started with ${stopService.name}.`,
  `- Hand work to another agent, e.g. a change in another repo: ${proposeTask.name} with a prompt that stands on its own; ` +
    "the user approves, edits or rejects it in Trackwall. In a Trackwall session, then end your turn: when the task's " +
    "session finishes a turn, reports its result, gets a verification verdict, errs or exits, or the user rejects the " +
    `proposal, Trackwall asks you to call ${getUpdates.name}, which says what happened. To steer the task (${TASK_MESSAGE_USES}), ` +
    `send its session a message with ${sendMessage.name}. When the user asks to continue a task whose session no longer runs ` +
    `(its agent exited, or Trackwall restarted), ${resumeTask.name} resumes its conversation in its own worktree; a new ` +
    `${proposeTask.name} would start over on a new branch. ` +
    `An agent outside Trackwall gets no updates and sends no messages; it waits with ${waitForSession.name} (a session ` +
    "may too, to wait inside a turn): with the task id it returns when the proposal is rejected or the task's session " +
    `needs someone, goes stale or exits; when it times out (still pending, starting or working), call it again. ${getSession.name} shows ` +
    `the task's changed files and ${getTaskChanges.name} their diff (narrow it with paths): review it before you tell the ` +
    "user the work is done. Propose related tasks together, so the user can review them as one plan. " +
    `A task whose session proposed yours handed you its work: ${getHandoff.name} says where its branch is now and what changed since you last read it, and ` +
    `${getChangedEndpoints.name} with its task which endpoints it changed.`,
  `- Keep ideas and split work on the user's board: when the user asks you to note something for later, or you find work ` +
    `outside your task, write it with ${createItem.name} instead of leaving it in your answer. ${listItems.name} shows the ` +
    `business projects, the items split under them and the ideas in the inbox; ${getItem.name} reads one with its plan and ` +
    `tasks. To split an item, create the smaller ones under it (parent) or propose tasks for it with ${proposeTask.name} and ` +
    `its item; ${updateItem.name} changes an item's text or moves it between ideas and ready. Nothing on the board starts ` +
    "work: the user starts a task from an item or approves your proposal.",
  `- Change the projects folder itself, which no task can: ${proposeFolderAction.name} proposes removing a repo, and ` +
    "the user approves it in Trackwall.",
  `- Catch up after a break: ${getDayReport.name} says what changed since the user's previous day start (new commits ` +
    "on each repo's default branch, repos the sync could not update, open tasks and how far behind they are), computed " +
    "once when the user started their day; read it instead of walking every repo.",
  `- ${listSessions.name} shows the Copilot CLI sessions and tasks Trackwall runs (caller is your own session); a session ` +
    `that runs a task ends its work with ${reportResult.name}. When the user sends a review of its changes, Trackwall asks ` +
    `it to call ${getReviewComments.name}, which returns the comments to address; when the session that proposed the task ` +
    `sends a message, Trackwall asks it to call ${getMessages.name}.`,
  `- Point the user at a repo, session or task in your answer with a link: ${trackwallLink("repo", "<repo id>")}, ` +
    `${trackwallLink("session", "<session id>")} or ${trackwallLink("task", "<task id>")} (also for a task proposal) ` +
    "opens it in Trackwall when clicked. A link only shows it, it never runs anything.",
  `- When you or the user are unsure what Trackwall can do or how a feature works, look it up in the documentation (${TRACKWALL_DOCS_URL}; ` +
    `${TRACKWALL_DOCS_LLMS_URL} lists its pages) instead of guessing; it follows the development version, so a feature ` +
    "there may be newer than the running Trackwall.",
].join("\n");
