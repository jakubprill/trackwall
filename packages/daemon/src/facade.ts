import { join } from "node:path";
import { Mise } from "./modules/mise/mise.ts";
import { ProcessGroups } from "./modules/procs/process-groups.ts";
import { RuntimeFile } from "./modules/procs/runtime-file.ts";
import { Vcs } from "./modules/vcs/vcs.ts";
import { Workspace } from "./modules/workspace/workspace.ts";
import { WorkspaceFile } from "./modules/workspace/workspace-file.ts";
import { groupPlatform } from "./platform/group-platform.ts";

/**
 * Fasada (§4): moduły daemona złożone w jednym miejscu. Zależności między modułami widać tylko tutaj;
 * moduł deklaruje, czego potrzebuje (np. `WorkspaceVcs`), a fasada podaje mu inny moduł.
 */
export interface Facade {
  workspace: Workspace;
  mise: Mise;
  procs: ProcessGroups;
}

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";

export interface FacadeOptions {
  /** Katalog stanu daemona; tam leżą `workspace.yaml` (ADR-13) i `runtime.json` (§4.1). */
  home: string;
  openUrl: (url: string) => void;
  /** Program `mise` z argumentami przed komendą (`["mise"]` w daemonie). */
  miseCommand: readonly string[];
  /** Środowisko procesów uruchamianych dla użytkownika (`userEnv`). */
  userEnv: () => Promise<NodeJS.ProcessEnv>;
  log: (msg: string) => void;
}

export function createFacade(o: FacadeOptions): Facade {
  const vcs = new Vcs();
  const workspace = new Workspace({ file: new WorkspaceFile(join(o.home, WORKSPACE_FILE)), vcs, openUrl: o.openUrl });
  const procs = new ProcessGroups({ runtime: new RuntimeFile(join(o.home, RUNTIME_FILE)), platform: groupPlatform(), log: o.log });
  const mise = new Mise({ procs, repos: workspace, command: o.miseCommand, env: o.userEnv });
  return { workspace, mise, procs };
}
