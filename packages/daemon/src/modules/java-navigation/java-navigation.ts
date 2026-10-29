import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type JavaNavigationInstall,
  type JavaNavigationSettings,
  type JavaNavigationState,
  LANGUAGE_SERVER_DIR_NAME,
} from "@trackwall/protocol";
import { configOrProblem, messageOf } from "../../infra/errors.ts";
import { javaProgramIn } from "./java-program.ts";
import type { JdtlsRelease } from "./jdtls-release.ts";

/**
 * Installing Java navigation (§4.17, ADR-123): the pinned jdtls release, downloaded, checked against its SHA-256 and
 * unpacked into `.trackwall-lsp/jdtls-<version>` in the projects folder (the folder an antivirus may be told to skip),
 * and the Java it runs on through `mise install`, whose paths then become `javaNavigation` in `workspace.yaml`. One
 * install runs at a time, in the background; its state lives in memory. An unpacked release is complete or absent
 * (unpacked beside it, then renamed), so a second install reuses it and a failed one leaves nothing half there.
 */

/** What the module needs from `workspace` and the system; the facade passes the real ones, tests fakes. */
export interface JavaNavigationDeps {
  repos: {
    /** `bad_request` while the projects folder is not set. */
    projectsDir(): Promise<string>;
    /** `javaNavigation` from `workspace.yaml`; `invalid_config` for a bad key. */
    javaNavigation(): JavaNavigationSettings | null;
    setJavaNavigation(settings: JavaNavigationSettings): void;
  };
  /** Whether tasks can get Java navigation now (`agents`). */
  readiness: () => JavaNavigationState;
  release: JdtlsRelease;
  /** The Java version as mise names it (`temurin-25`). */
  java: string;
  /** Downloads `url` into `file` and checks its SHA-256 (`downloadVerified`). */
  download: (url: string, file: string, sha256: string) => Promise<void>;
  /** Unpacks a `.tar.gz` into an existing folder (`extractTarGz`). */
  extract: (archive: string, dir: string) => Promise<void>;
  /** Installs a tool with mise, running in `dir`, and returns its folder (`mise`). */
  installTool: (spec: string, dir: string) => Promise<string>;
  log: (msg: string) => void;
}

export class JavaNavigation {
  readonly #deps: JavaNavigationDeps;
  #step: string | null = null;
  #error: string | null = null;

  constructor(deps: JavaNavigationDeps) {
    this.#deps = deps;
  }

  install(): JavaNavigationInstall {
    return {
      jdtls: this.#deps.release.version,
      java: this.#deps.java,
      running: this.#step !== null,
      step: this.#step,
      error: this.#error,
      readiness: this.#deps.readiness(),
    };
  }

  /** Starts an install unless one runs; the state says when it ends and how. */
  startInstall(): JavaNavigationInstall {
    if (this.#step === null) {
      this.#error = null;
      this.#step = "Starting";
      void this.#install().then(
        () => {
          this.#step = null;
        },
        (err: unknown) => {
          this.#deps.log(`installing Java navigation: ${messageOf(err)}`);
          this.#error = messageOf(err);
          this.#step = null;
        },
      );
    }
    return this.install();
  }

  async #install(): Promise<void> {
    const dir = join(await this.#deps.repos.projectsDir(), LANGUAGE_SERVER_DIR_NAME);
    const jdtls = await this.#jdtls(dir);
    this.#step = `Installing Java ${this.#deps.java} with mise`;
    const java = javaProgramIn(await this.#deps.installTool(`java@${this.#deps.java}`, dir));
    this.#step = "Saving the settings";
    // A Lombok jar the user named stays; a broken key is replaced by the installed paths.
    const lombok = configOrProblem(() => this.#deps.repos.javaNavigation(), null).value?.lombok ?? null;
    this.#deps.repos.setJavaNavigation({ jdtls, java, lombok });
  }

  /** The unpacked release, downloaded unless an earlier install left it. */
  async #jdtls(dir: string): Promise<string> {
    const { version, url, sha256 } = this.#deps.release;
    const target = join(dir, `jdtls-${version}`);
    if (existsSync(target)) return target;
    mkdirSync(dir, { recursive: true });
    const work = mkdtempSync(join(dir, ".install-"));
    try {
      this.#step = `Downloading jdtls ${version}`;
      const archive = join(work, "jdtls.tar.gz");
      await this.#deps.download(url, archive, sha256);
      this.#step = `Unpacking jdtls ${version}`;
      const unpacked = join(work, "jdtls");
      mkdirSync(unpacked);
      await this.#deps.extract(archive, unpacked);
      renameSync(unpacked, target);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return target;
  }
}
