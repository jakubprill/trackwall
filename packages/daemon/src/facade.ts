import { join } from "node:path";
import { HOSTING_CLIS, Hosting } from "./modules/vcs/hosting.ts";
import { Vcs } from "./modules/vcs/vcs.ts";
import { Workspace } from "./modules/workspace/workspace.ts";
import { WorkspaceFile } from "./modules/workspace/workspace-file.ts";

/**
 * Fasada (§4): moduły daemona złożone w jednym miejscu. Zależności między modułami widać tylko tutaj;
 * moduł deklaruje, czego potrzebuje (np. `WorkspaceVcs`), a fasada podaje mu inny moduł.
 */
export interface Facade {
  workspace: Workspace;
}

const WORKSPACE_FILE = "workspace.yaml";

export interface FacadeOptions {
  /** Katalog stanu daemona; tam leży `workspace.yaml` (ADR-13). */
  home: string;
  openUrl: (url: string) => void;
}

export function createFacade(o: FacadeOptions): Facade {
  const workspace = new Workspace({
    file: new WorkspaceFile(join(o.home, WORKSPACE_FILE)),
    vcs: new Vcs(),
    hosting: new Hosting(HOSTING_CLIS),
    openUrl: o.openUrl,
  });
  return { workspace };
}
