import { join } from "node:path";
import { Agents, type AgentsDeps } from "./modules/agents/agents.ts";
import { Logs } from "./modules/logs/logs.ts";
import { Mise } from "./modules/mise/mise.ts";
import { ProcessGroups } from "./modules/procs/process-groups.ts";
import { RuntimeFile } from "./modules/procs/runtime-file.ts";
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
  mise: Mise;
  procs: ProcessGroups;
  logs: Logs;
  agents: Agents;
}

export { runCopilotHook } from "./modules/agents/copilot-hook-command.ts";

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";
const LOGS_DIR = "logs";
/** Limit jednego pliku JSONL źródła; z poprzednim plikiem po rotacji źródło zajmuje najwyżej dwa razy tyle. */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface FacadeOptions {
  /** Katalog stanu daemona; tam leżą `workspace.yaml` (ADR-13), `runtime.json` (§4.1) i `logs/` (§4.2). */
  home: string;
  openUrl: (url: string) => void;
  /** Program `mise` z argumentami przed komendą (`["mise"]` w daemonie). */
  miseCommand: readonly string[];
  /** Program Copilot CLI z argumentami przed argumentami sesji (`["copilot"]` w daemonie, atrapa w testach). */
  copilotCommand: readonly string[];
  /** Program hooka wtyczki sesji (`trackwall-daemon copilot-hook …` w daemonie). */
  hookCommand: AgentsDeps["hookCommand"];
  /** Most stdio do serwera MCP tego daemona (`mcpStdioCommand`), który dostaje każda sesja Copilot CLI. */
  mcpStdioCommand: readonly string[];
  /** Środowisko procesów uruchamianych dla użytkownika (`userEnv`). */
  userEnv: () => Promise<NodeJS.ProcessEnv>;
  log: (msg: string) => void;
}

export function createFacade(o: FacadeOptions): Facade {
  const workspace = new Workspace({
    file: new WorkspaceFile(join(o.home, WORKSPACE_FILE)),
    vcs: new Vcs(),
    hosting: new Hosting(HOSTING_CLIS),
    openUrl: o.openUrl,
  });
  const logs = new Logs({ dir: join(o.home, LOGS_DIR), maxFileBytes: LOG_FILE_MAX_BYTES, log: o.log });
  const procs = new ProcessGroups({
    runtime: new RuntimeFile(join(o.home, RUNTIME_FILE)),
    logs,
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: o.log,
  });
  const mise = new Mise({ procs, repos: workspace, command: o.miseCommand, env: o.userEnv });
  const agents = new Agents({
    procs,
    repos: workspace,
    home: o.home,
    copilot: o.copilotCommand,
    env: o.userEnv,
    hookCommand: o.hookCommand,
    mcpStdioCommand: o.mcpStdioCommand,
    log: o.log,
  });
  return { workspace, mise, procs, logs, agents };
}
