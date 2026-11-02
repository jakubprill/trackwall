import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { JavaNavigationSettings, JavaNavigationStatus, SessionView } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { ensureTrackwallDir, trackwallDir } from "../../infra/trackwall-dir.ts";
import type { LspServer } from "./copilot-plugin.ts";
import {
  JAVA_LSP_SERVER,
  type JavaNavigationReadiness,
  javaLanguageServer,
  javaNavigationReadiness,
  mavenOnlyImport,
} from "./java-language-server.ts";
import { jdtlsStatus, readJdtlsLog } from "./jdtls-log.ts";

/**
 * The jdtls of whoever has Java navigation (§4.4, ADR-99, ADR-175): a task, under its id, or a repo session in a repo
 * root, under the session's id. Each owner has its own data folder in `<projects folder>/.trackwall/lsp/<owner>`, since
 * two jdtls must not share one; it lasts while the owner does, so a resume or restart starts warm, and goes with it.
 */
export interface JavaNavigationServersDeps {
  /** The projects folder, which holds the data folders. */
  projectsDir(): Promise<string>;
  /** `javaNavigation` from `workspace.yaml`; `null` without the key. */
  settings(): JavaNavigationSettings | null;
  log: (msg: string) => void;
}

export class JavaNavigationServers {
  readonly #deps: JavaNavigationServersDeps;

  constructor(deps: JavaNavigationServersDeps) {
    this.#deps = deps;
  }

  /** Whether jdtls can start now, read from `workspace.yaml` and the disk at every call. */
  readiness(): JavaNavigationReadiness {
    return javaNavigationReadiness(() => this.#deps.settings());
  }

  /**
   * Refuses a start that asks for Java navigation it would not get, before anything is made for it: the conversation
   * view, where Copilot CLI does not load the session plugin's servers (ADR-137), or settings with a problem.
   */
  assertCanStart(view: SessionView, who: string): void {
    if (view === "conversation")
      throw new DomainError("bad_request", `Java navigation needs ${who} in a terminal; the conversation view cannot give it yet`);
    const { problem } = this.readiness();
    if (problem !== null) throw new DomainError("bad_request", `Java navigation cannot start: ${problem}`);
  }

  /**
   * The `lspServers` of a start of `who` (owner `owner`, working in `cwd`). A start whose settings were removed or broke
   * since the owner asked for it starts without jdtls and logs why: the agent still works, only without the `lsp` tool.
   */
  async servers(owner: string, cwd: string, who: string): Promise<Record<string, LspServer>> {
    const { settings, problem } = this.readiness();
    if (settings === null) {
      this.#deps.log(`${who} starts without Java navigation: ${problem}`);
      return {};
    }
    await ensureTrackwallDir(await this.#deps.projectsDir(), "lsp");
    return { [JAVA_LSP_SERVER]: javaLanguageServer(settings, await this.#dataDir(owner), mavenOnlyImport(cwd)) };
  }

  /** How the owner's jdtls is doing (ADR-124), from its log; `startedAt` is when its running session started. */
  async status(owner: string, startedAt: Date | null): Promise<JavaNavigationStatus> {
    return jdtlsStatus(await readJdtlsLog(await this.#dataDir(owner)), new Date(), startedAt);
  }

  /** The index jdtls built for the owner; a failure only leaves files behind, so it is logged. */
  async remove(owner: string, who: string): Promise<void> {
    try {
      await rm(await this.#dataDir(owner), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`removing the Java navigation data of ${who}: ${messageOf(err)}`);
    }
  }

  async #dataDir(owner: string): Promise<string> {
    return join(trackwallDir(await this.#deps.projectsDir(), "lsp"), owner);
  }
}
