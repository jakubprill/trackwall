import { join } from "node:path";
import { vscodeUrl } from "./infra/editor-url.ts";
import { Agents, type AgentsDeps } from "./modules/agents/agents.ts";
import { Batch } from "./modules/batch/batch.ts";
import { CardCache } from "./modules/cards/card-cache.ts";
import { Cards } from "./modules/cards/cards.ts";
import { Graph } from "./modules/graph/graph.ts";
import { Logs } from "./modules/logs/logs.ts";
import { Mise } from "./modules/mise/mise.ts";
import { ProcessGroups } from "./modules/procs/process-groups.ts";
import { RuntimeFile } from "./modules/procs/runtime-file.ts";
import { Services } from "./modules/services/services.ts";
import { TestReports } from "./modules/test-results/test-reports.ts";
import { HOSTING_CLIS, Hosting } from "./modules/vcs/hosting.ts";
import { Vcs } from "./modules/vcs/vcs.ts";
import { Workspace } from "./modules/workspace/workspace.ts";
import { WorkspaceFile } from "./modules/workspace/workspace-file.ts";
import { groupPlatform } from "./platform/group-platform.ts";
import { terminalPlatform } from "./platform/terminal.ts";

/**
 * The facade (§4): the daemon's modules assembled in one place. Dependencies between modules are visible only here;
 * a module declares what it needs (e.g. `WorkspaceVcs`), and the facade hands it another module.
 */
export interface Facade {
  workspace: Workspace;
  cards: Cards;
  graph: Graph;
  mise: Mise;
  procs: ProcessGroups;
  logs: Logs;
  agents: Agents;
  batch: Batch;
  services: Services;
  testReports: TestReports;
  /**
   * Opens a link from a README in the system (ADR-35): an `http` or `https` address checked by the `ExternalLink` schema.
   * It belongs to no module, because it concerns neither a repo nor the daemon's state.
   */
  openLink: (url: string) => void;
}

export { runCopilotHook } from "./modules/agents/copilot-hook-command.ts";

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";
const CARDS_DIR = "cards";
const LOGS_DIR = "logs";
/** The limit of one source JSONL file; with the previous file after rotation a source takes at most twice that. */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Service readiness (ADR-45): checks twice a second, and five minutes for a start, because Gradle and Maven compile first. */
const SERVICE_TIMING = { intervalMs: 500, startupMs: 5 * 60 * 1000, settleMs: 500 };

export interface FacadeOptions {
  /**
   * The daemon's state directory; it holds `workspace.yaml` (ADR-13), `runtime.json` (§4.1), `logs/` (§4.2) and repo cards
   * (`cards/`, ADR-25).
   */
  home: string;
  openUrl: (url: string) => void;
  openFolder: (dir: string) => void;
  /** The `mise` program with arguments before the command (`["mise"]` in the daemon). */
  miseCommand: readonly string[];
  /** The Copilot CLI program with arguments before the session's arguments (`["copilot"]` in the daemon, a fake in tests). */
  copilotCommand: readonly string[];
  /** The daemon's version (`VERSION`), given to every Copilot CLI session. */
  version: string;
  /** The session plugin's hook program (`trackwall-daemon copilot-hook …` in the daemon). */
  hookCommand: AgentsDeps["hookCommand"];
  /** The Stdio bridge to this daemon's MCP server with the session token file (`sessionMcpStdioCommand`), for every Copilot CLI session. */
  sessionMcpCommand: AgentsDeps["sessionMcpCommand"];
  /** The environment of processes started for the user (`userEnv`). */
  userEnv: () => Promise<NodeJS.ProcessEnv>;
  log: (msg: string) => void;
}

export function createFacade(o: FacadeOptions): Facade {
  const vcs = new Vcs();
  const openEditor = (dir: string) => o.openUrl(vscodeUrl(dir));
  const workspace = new Workspace({
    file: new WorkspaceFile(join(o.home, WORKSPACE_FILE)),
    vcs,
    hosting: new Hosting(HOSTING_CLIS),
    openEditor,
    openFolder: o.openFolder,
  });
  const logs = new Logs({ dir: join(o.home, LOGS_DIR), maxFileBytes: LOG_FILE_MAX_BYTES, log: o.log });
  const procs = new ProcessGroups({
    runtime: new RuntimeFile(join(o.home, RUNTIME_FILE)),
    logs,
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: o.log,
  });
  const cache = new CardCache(join(o.home, CARDS_DIR), o.log);
  cache.prune().catch((err: unknown) => o.log(`failed to clean up cards: ${String(err)}`));
  const cards = new Cards({ vcs, repos: workspace, cache });
  const agents = new Agents({
    procs,
    repos: workspace,
    vcs,
    home: o.home,
    copilot: o.copilotCommand,
    version: o.version,
    env: o.userEnv,
    hookCommand: o.hookCommand,
    sessionMcpCommand: o.sessionMcpCommand,
    openEditor,
    log: o.log,
  });
  const mise = new Mise({ procs, repos: workspace, tasks: agents, command: o.miseCommand, env: o.userEnv });
  const batch = new Batch({ workspace, mise, log: o.log });
  const graph = new Graph({ cards, workspace });
  const taskPort = (repo: string, task: string) => agents.taskPort(repo, task);
  const services = new Services({ mise, logs, graph, cards, taskPort, env: o.userEnv, ...SERVICE_TIMING });
  const testReports = new TestReports({ repos: workspace, tasks: agents, logs, env: o.userEnv });
  return { workspace, cards, graph, mise, procs, logs, batch, agents, services, testReports, openLink: o.openUrl };
}
