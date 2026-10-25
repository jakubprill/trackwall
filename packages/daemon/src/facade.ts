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
import { HOSTING_CLIS, Hosting } from "./modules/vcs/hosting.ts";
import { Vcs } from "./modules/vcs/vcs.ts";
import { Workspace } from "./modules/workspace/workspace.ts";
import { WorkspaceFile } from "./modules/workspace/workspace-file.ts";
import { groupPlatform } from "./platform/group-platform.ts";
import { terminalPlatform } from "./platform/terminal.ts";

/**
 * Fasada (§4): moduły daemona złożone w jednym miejscu. Zależności między modułami widać tylko tutaj;
 * moduł deklaruje, czego potrzebuje (np. `WorkspaceVcs`), a fasada podaje mu inny moduł.
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
  /**
   * Otwiera w systemie link z README (ADR-35): adres `http` albo `https` sprawdzony schematem `ExternalLink`.
   * Nie należy do żadnego modułu, bo nie dotyczy repo ani stanu daemona.
   */
  openLink: (url: string) => void;
}

export { runCopilotHook } from "./modules/agents/copilot-hook-command.ts";

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";
const CARDS_DIR = "cards";
const LOGS_DIR = "logs";
/** Limit jednego pliku JSONL źródła; z poprzednim plikiem po rotacji źródło zajmuje najwyżej dwa razy tyle. */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Service readiness (ADR-45): checks twice a second, and five minutes for a start, because Gradle and Maven compile first. */
const SERVICE_TIMING = { intervalMs: 500, startupMs: 5 * 60 * 1000, settleMs: 500 };

export interface FacadeOptions {
  /** Katalog stanu daemona; tam leżą `workspace.yaml` (ADR-13), `runtime.json` (§4.1) `logs/` (§4.2) i karty repo (`cards/`, ADR-25). */
  home: string;
  openUrl: (url: string) => void;
  openFolder: (dir: string) => void;
  /** Program `mise` z argumentami przed komendą (`["mise"]` w daemonie). */
  miseCommand: readonly string[];
  /** Program Copilot CLI z argumentami przed argumentami sesji (`["copilot"]` w daemonie, atrapa w testach). */
  copilotCommand: readonly string[];
  /** The daemon's version (`VERSION`), given to every Copilot CLI session. */
  version: string;
  /** Program hooka wtyczki sesji (`trackwall-daemon copilot-hook …` w daemonie). */
  hookCommand: AgentsDeps["hookCommand"];
  /** Most stdio do serwera MCP tego daemona z plikiem tokenu sesji (`sessionMcpStdioCommand`), który dostaje każda sesja Copilot CLI. */
  sessionMcpCommand: AgentsDeps["sessionMcpCommand"];
  /** Środowisko procesów uruchamianych dla użytkownika (`userEnv`). */
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
  const services = new Services({ mise, logs, graph, cards, env: o.userEnv, ...SERVICE_TIMING });
  return { workspace, cards, graph, mise, procs, logs, batch, agents, services, openLink: o.openUrl };
}
