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
  whoCalls,
  subgraphFor,
  findEndpoint,
  listSessions,
  getSession,
  proposeTask,
  reportResult,
  waitForSession,
} = mcpTools;

export const MCP_INSTRUCTIONS = [
  "Trackwall is the user's local workbench for the git repos in their projects folder: it syncs them, reads their build " +
    "files and code into repo cards and a graph of connections between apps, runs mise tasks and Copilot CLI sessions. " +
    `Its tools give you that knowledge. Only ${proposeTask.name} and ${reportResult.name} record anything, and no tool changes ` +
    "repos, configuration or processes.",
  "",
  "How to work with it:",
  `- Find repos: ${listRepos.name} (narrow it with tags such as java, bff or frontend) gives the repo ids the other tools ` +
    `take. ${getRepo.name} adds the README, recent commits and mise tasks.`,
  `- Understand a repo: ${getRepoCard.name} lists what it provides (packages, Spring Boot apps, HTTP endpoints, DTOs) and ` +
    "consumes (packages, HTTP clients), each fact with file and line. Start there instead of reading build files, then " +
    "open the files it points to.",
  `- Before you change an endpoint, a DTO, a package or a config address, check whom it affects: ${findEndpoint.name} ` +
    `shows who calls an endpoint, ${whoCalls.name} which repos depend on a repo, ${subgraphFor.name} its neighbourhood. ` +
    "Connections with low or medium confidence are hints: confirm them in the code. Name the affected repos in your result.",
  `- Diagnose a running service: ${tail.name} reads the log of a repo's mise task (${getRepo.name} lists them); pass nextSeq ` +
    "as sinceSeq to follow it.",
  `- Hand work to another agent, e.g. a change in another repo: ${proposeTask.name} with a prompt that stands on its own; ` +
    `the user approves, edits or rejects it in Trackwall. Then call ${waitForSession.name} with the task id: it returns ` +
    "when the proposal is rejected or the task's session needs someone (finished its turn, asks for approval), goes " +
    `stale or exits; when it times out (still pending, starting or working), call it again. ${getSession.name} shows ` +
    "the task's changed files.",
  `- ${listSessions.name} shows the Copilot CLI sessions and tasks Trackwall runs (caller is your own session); a session ` +
    `that runs a task ends its work with ${reportResult.name}.`,
].join("\n");
