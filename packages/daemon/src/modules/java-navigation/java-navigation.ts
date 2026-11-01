import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JavaNavigationInstall, JavaNavigationSettings, JavaNavigationState } from "@trackwall/protocol";
import { configOrProblem, messageOf } from "../../infra/errors.ts";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { javaMajors } from "./java-majors.ts";
import { javaProgramIn } from "./java-program.ts";
import type { PinnedRelease } from "./pinned-releases.ts";

/**
 * Installing Java navigation (§4.17, ADR-123): the pinned jdtls release, downloaded, checked against its SHA-256 and
 * unpacked into `.trackwall/lsp/jdtls-<version>` in the projects folder (the folder an antivirus may be told to skip),
 * the pinned Lombok jar next to it, the Java it runs on and the Java versions the repos build with through
 * `mise install` (ADR-167), whose paths then become `javaNavigation` in `workspace.yaml`. One
 * install runs at a time, in the background; its state lives in memory. Every install downloads and checks the release
 * again and replaces the folder, so "Install again" repairs a damaged or changed one and nothing unchecked is adopted;
 * the release is unpacked in a temporary folder and renamed into place, so it is there whole or not at all.
 */

/** The prefix of an install's temporary folder in `.trackwall/lsp`; one left by a daemon that stopped mid-install is removed by the next. */
const INSTALL_DIR_PREFIX = ".install-";

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
  release: PinnedRelease;
  lombok: PinnedRelease;
  /** The Java version as mise names it (`temurin-25`). */
  java: string;
  /** The Java versions the repos' cards name (`17`, `1.8`, `temurin-21`), any number of times (`cards`). */
  projectJava: () => Promise<readonly string[]>;
  /** Downloads `url` into `file` and checks its SHA-256 (`downloadVerified`). */
  download: (url: string, file: string, sha256: string) => Promise<void>;
  /** Unpacks a `.tar.gz` into an existing folder (`extractTarGz`). */
  extract: (archive: string, dir: string) => Promise<void>;
  /** Installs a tool with mise, running in the empty folder `dir`, and returns its folder (`mise`). */
  installTool: (spec: string, dir: string) => Promise<string>;
  log: (msg: string) => void;
}

export class JavaNavigation {
  readonly #deps: JavaNavigationDeps;
  #step: string | null = null;
  #error: string | null = null;
  #warning: string | null = null;

  constructor(deps: JavaNavigationDeps) {
    this.#deps = deps;
  }

  state(): JavaNavigationInstall {
    return {
      jdtls: this.#deps.release.version,
      java: this.#deps.java,
      lombok: this.#deps.lombok.version,
      step: this.#step,
      error: this.#error,
      warning: this.#warning,
      readiness: this.#deps.readiness(),
    };
  }

  /** Starts an install unless one runs; the state says when it ends and how. */
  startInstall(): JavaNavigationInstall {
    if (this.#step === null) {
      this.#error = null;
      this.#warning = null;
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
    return this.state();
  }

  async #install(): Promise<void> {
    const dir = await ensureTrackwallDir(await this.#deps.repos.projectsDir(), "lsp");
    await removeStaleInstalls(dir);
    const work = await mkdtemp(join(dir, INSTALL_DIR_PREFIX));
    try {
      const jdtls = await this.#jdtls(dir, work);
      const installedLombok = await this.#lombok(dir, work);
      this.#step = `Installing Java ${this.#deps.java} with mise`;
      // An empty folder of this install's own, so no mise config, planted or not, takes part.
      const miseDir = join(work, "mise");
      await mkdir(miseDir);
      const java = javaProgramIn(await this.#deps.installTool(`java@${this.#deps.java}`, miseDir));
      const { homes, missing } = await this.#projectRuntimes(miseDir);
      this.#step = "Saving the settings";
      // A Lombok jar and runtimes the user named stay; a broken key is replaced by the installed paths.
      const previous = configOrProblem(() => this.#deps.repos.javaNavigation(), null).value;
      const ownLombok = previous?.lombok && dirname(previous.lombok) !== dir ? previous.lombok : null;
      const runtimes = [...new Set([...homes, ...(previous?.runtimes ?? []).filter((home) => existsSync(home))])];
      this.#deps.repos.setJavaNavigation({ jdtls, java, lombok: ownLombok ?? installedLombok, runtimes });
      // Navigation works without them; only a project that needs one of these Java versions does not import.
      if (missing.length > 0) this.#warning = `mise could not install ${missing.join("; ")}`;
    } finally {
      // The install's outcome stands; a temporary folder Windows still holds is only logged.
      await removeFolder(work, removeIfPresent).catch((err: unknown) => this.#deps.log(`could not remove ${work}: ${messageOf(err)}`));
    }
  }

  /**
   * Installs with mise each Java version a repo's card names (as Temurin, like jdtls's own), and returns their folders
   * and the versions mise could not install, with its message: Java 8 has no Temurin build for Apple silicon, say.
   */
  async #projectRuntimes(miseDir: string): Promise<{ homes: string[]; missing: string[] }> {
    const homes: string[] = [];
    const missing: string[] = [];
    for (const major of javaMajors(await this.#deps.projectJava())) {
      this.#step = `Installing Java ${major} for your projects with mise`;
      try {
        // The folder `release` lies in: inside a macOS bundle that is `Contents/Home`, two levels above `bin/java`.
        homes.push(dirname(dirname(javaProgramIn(await this.#deps.installTool(`java@temurin-${major}`, miseDir)))));
      } catch (err) {
        missing.push(`Java ${major}: ${messageOf(err)}`);
      }
    }
    return { homes, missing };
  }

  /** Downloads and checks the Lombok jar in `work`, then puts it in place of any earlier copy in `dir`. */
  async #lombok(dir: string, work: string): Promise<string> {
    const { version, url, sha256 } = this.#deps.lombok;
    this.#step = `Downloading Lombok ${version}`;
    const downloaded = join(work, "lombok.jar");
    await this.#deps.download(url, downloaded, sha256);
    const target = join(dir, `lombok-${version}.jar`);
    await rename(downloaded, target).catch((err: unknown) => {
      throw new Error(`could not replace ${target}; end the tasks with Java navigation and install again (${messageOf(err)})`);
    });
    return target;
  }

  /** Downloads, checks and unpacks the release in `work`, then puts it in place of any earlier copy. */
  async #jdtls(dir: string, work: string): Promise<string> {
    const { version, url, sha256 } = this.#deps.release;
    const target = join(dir, `jdtls-${version}`);
    this.#step = `Downloading jdtls ${version}`;
    const archive = join(work, "jdtls.tar.gz");
    await this.#deps.download(url, archive, sha256);
    this.#step = `Unpacking jdtls ${version}`;
    const unpacked = join(work, "jdtls");
    await mkdir(unpacked);
    await this.#deps.extract(archive, unpacked);
    if (!(await exists(target))) {
      await rename(unpacked, target);
      return target;
    }
    // The earlier copy goes into the temporary folder and away with it; on Windows a task's running jdtls holds it, and the error says so.
    const previous = join(work, "previous");
    await rename(target, previous).catch((err: unknown) => {
      throw new Error(`could not replace ${target}; end the tasks with Java navigation and install again (${messageOf(err)})`);
    });
    try {
      await rename(unpacked, target);
    } catch (err) {
      // The settings still name `target`: the earlier copy goes back rather than leave them pointing at nothing.
      await rename(previous, target);
      throw err;
    }
    return target;
  }
}

async function removeStaleInstalls(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(INSTALL_DIR_PREFIX)) await removeFolder(join(dir, name), removeIfPresent).catch(() => {});
  }
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
